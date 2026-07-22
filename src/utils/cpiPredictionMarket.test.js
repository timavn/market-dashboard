import {
  buildCpiEventsFromPositions,
  buildCpiContractLadder,
  deriveCpiTargetStrikes,
  extractCpiAboveThreshold,
  getCpiContractMonthId,
  isIbkrTradableCpiEvent,
  isCpiContractForMonth,
  normalizeCpiMonthId,
  normalizeCpiNowcast,
  summarizeCpiPositions,
} from './cpiPredictionMarket';

const MOM_SNAPSHOT = {
  date: '2026-06-16',
  publishedAt: '2026-06-16T15:47:00Z',
  data: {
    metric: 'Headline CPI M/M',
    forecastMonth: 'June 2026',
    publishedText: '06/16/2026 11:47 AM EDT',
    releaseDate: { date: '2026-07-14' },
    outlook: 'Probable Disinflation',
    scenarios: [
      { key: 'upside', label: 'Upside', value: 0.4 },
      { key: 'base', label: 'Base Case', value: 0.3 },
      { key: 'downside', label: 'Downside', value: 0.2 },
    ],
  },
};

const YOY_SNAPSHOT = {
  data: {
    metric: 'Headline CPI YoY',
    scenarios: [
      { key: 'upside', label: 'Upside', value: 3.99 },
      { key: 'base', label: 'Base Case', value: 3.88 },
      { key: 'downside', label: 'Downside', value: 3.77 },
    ],
  },
};

function makeEvent(overrides = {}) {
  return {
    id: 'forecastex:cpi-03',
    venue: 'ForecastEx',
    source_api: 'IBKR_CPAPI',
    tradable_in_ibkr: true,
    category: 'Inflation',
    underlying: 'CPIM',
    contract_title: 'Above 0.3%',
    question: 'Will US CPI M/M be Above 0.3% for June 2026?',
    yes_ask: 0.25,
    yes_bid: 0.23,
    no_ask: 0.76,
    no_bid: 0.74,
    volume: 1000,
    max_payout_per_contract: 1,
    ...overrides,
  };
}

const SETTINGS = {
  portfolioEquity: 100000,
  maxRiskPerBet: 500,
  maxOpenRisk: 500,
  kellyMultiplier: 0.25,
  minNetEdge: 0.02,
  defaultFeePerContract: 0,
  defaultSlippageBuffer: 0,
  modelErrorBuffer: 0,
};

const LIVE_CPI_POSITIONS = [
  {
    symbol: 'KXCPIYOY',
    description: 'KXCPIYOY-26JUN-T4.2_NO',
    accountId: 'U25779973',
    quantity: 19,
    avgCost: 0.47,
    price: null,
    marketValue: null,
    costBasis: 8.93,
    conid: 882340051,
    secType: 'OPT',
  },
  {
    symbol: 'KXCPIYOY',
    description: 'KXCPIYOY-26JUN-T4.1_NO',
    accountId: 'U25779973',
    quantity: 13,
    avgCost: 0.81,
    price: null,
    marketValue: null,
    costBasis: 10.53,
    conid: 882340040,
    secType: 'OPT',
  },
  {
    symbol: 'KXCPIYOY',
    description: 'KXCPIYOY-26JUN-T3.8_YES',
    accountId: 'U25779973',
    quantity: 2000,
    avgCost: 0.6325,
    price: null,
    marketValue: null,
    costBasis: 1265,
    conid: 872435625,
    secType: 'OPT',
  },
  {
    symbol: 'KXCPIYOY',
    description: 'KXCPIYOY-26JUN-T4.0_NO',
    accountId: 'U25779973',
    quantity: 427.27,
    avgCost: 0.71529385,
    price: null,
    marketValue: null,
    costBasis: 305.6236032895,
    conid: 872435582,
    secType: 'OPT',
  },
];

function findStrikeRow(rows, threshold) {
  return rows.find((row) => Math.abs(Number(row.threshold) - threshold) < 0.0001);
}

describe('normalizeCpiNowcast', () => {
  test('accepts native M/M nowcast snapshots', () => {
    const result = normalizeCpiNowcast(MOM_SNAPSHOT);

    expect(result.ok).toBe(true);
    expect(result.model.metric).toBe('Headline CPI M/M');
    expect(result.model.scenarios).toHaveLength(3);
    expect(result.model.scenarios[1]).toEqual({ key: 'base', label: 'Base Case', value: 0.3 });
  });

  test('accepts native YoY nowcast snapshots for YoY CPI contracts', () => {
    const result = normalizeCpiNowcast(YOY_SNAPSHOT);

    expect(result.ok).toBe(true);
    expect(result.model.metric).toBe('Headline CPI YoY');
    expect(result.model.scenarios[1]).toEqual({ key: 'base', label: 'Base Case', value: 3.88 });
  });

  test('prefers raw source percentages when a stale numeric zero is present', () => {
    const result = normalizeCpiNowcast({
      data: {
        metric: 'Headline CPI YoY',
        scenarios: [
          { key: 'upside', label: 'Upside', raw: '3.99%', value: 0 },
          { key: 'base', label: 'Base Case', raw: '3.88%', value: 0 },
          { key: 'downside', label: 'Downside', raw: '3.77%', value: 0 },
        ],
      },
    });

    expect(result.ok).toBe(true);
    expect(result.model.scenarios.map((scenario) => scenario.value)).toEqual([3.99, 3.88, 3.77]);
  });

  test('preserves missing snapshot state', () => {
    const result = normalizeCpiNowcast(null);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('missing_snapshot');
  });
});

describe('deriveCpiTargetStrikes', () => {
  test('rounds YoY scenarios and pads two strikes on each side', () => {
    const model = normalizeCpiNowcast(YOY_SNAPSHOT).model;

    expect(deriveCpiTargetStrikes(model)).toEqual([3.6, 3.7, 3.8, 3.9, 4, 4.1, 4.2]);
  });

  test('dedupes rounded scenarios while preserving padding', () => {
    expect(deriveCpiTargetStrikes([
      { value: 3.84 },
      { value: 3.85 },
      { value: 3.86 },
    ])).toEqual([3.6, 3.7, 3.8, 3.9, 4, 4.1]);
  });

  test('supports M/M values with 0.1 strike increments', () => {
    const model = normalizeCpiNowcast(MOM_SNAPSHOT).model;

    expect(deriveCpiTargetStrikes(model)).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
  });
});

describe('CPI report-month identity', () => {
  test('normalizes source labels and KX event ticker codes without using settlement dates', () => {
    expect(normalizeCpiMonthId('June 2026')).toBe('2026-06');
    expect(normalizeCpiMonthId('Jun 26')).toBe('2026-06');
    expect(normalizeCpiMonthId('KXCPIYOY-26JUL-T4.0_YES')).toBe('2026-07');
    expect(getCpiContractMonthId({
      event_ticker: 'KXCPIYOY-26JUL',
      releaseDate: '2026-08-12',
    })).toBe('2026-07');
  });

  test('rejects missing or internally inconsistent month identity for an active month', () => {
    expect(isCpiContractForMonth({ contract_title: 'Above 4.0%' }, { id: '2026-07' })).toBe(false);
    expect(isCpiContractForMonth({
      event_ticker: 'KXCPIYOY-26JUL',
      contract_title: 'June 2026 CPI above 4.0%',
    }, { id: '2026-07' })).toBe(false);
  });
});

describe('CPI contract ladder math', () => {
  test('extracts Above thresholds from contract text', () => {
    expect(extractCpiAboveThreshold(makeEvent({ contract_title: 'Above 0.4%' }))).toBeCloseTo(0.4);
  });

  test('extracts IBKR threshold tokens from KX CPI symbols', () => {
    expect(
      extractCpiAboveThreshold(makeEvent({
        symbol: 'KXCPIYOY',
        description: 'KXCPIYOY-26JUN-T3.8_YES',
        contract_title: null,
        question: null,
      })),
    ).toBeCloseTo(3.8);
  });

  test('recognizes IBKR KX CPI contract symbols as tradable CPI events', () => {
    expect(isIbkrTradableCpiEvent(makeEvent({
      venue: 'IBKR',
      source_api: 'IBKR_TWS_API',
      symbol: 'KXCPIYOY',
      description: 'KXCPIYOY-26JUN-T3.8_YES',
      contract_title: null,
      question: null,
    }))).toBe(true);
  });

  test('never promotes portfolio positions into live contract rows', () => {
    const model = normalizeCpiNowcast(YOY_SNAPSHOT).model;
    const events = buildCpiEventsFromPositions([
      {
        symbol: 'KXCPIYOY',
        description: 'KXCPIYOY-26JUN-T4.0_NO',
        accountId: 'U25779973',
        quantity: 427.27,
        price: 0.9249888829077634,
        marketValue: 395.22,
        costBasis: 305.6236032895,
        conid: 872435582,
      },
    ]);
    const rows = buildCpiContractLadder(events, model, SETTINGS);

    expect(events).toHaveLength(1);
    expect(events[0].contract_title).toBe('KXCPIYOY-26JUN-T4.0_NO');
    expect(events[0].tradable_in_ibkr).toBe(false);
    expect(events[0]).not.toHaveProperty('yes_mid');
    expect(events[0]).not.toHaveProperty('no_mid');
    expect(events[0]).not.toHaveProperty('last_price');
    expect(events[0].data_quality_flags).toEqual(expect.arrayContaining([
      'portfolio_derived',
      'no_live_quote',
    ]));
    expect(rows.map((row) => row.threshold)).toEqual([3.6, 3.7, 3.8, 3.9, 4, 4.1, 4.2]);
    expect(findStrikeRow(rows, 4.0).missingContract).toBe(true);
  });

  test('keeps live open CPI position exposure separate from fresh trade contracts', () => {
    const positions = summarizeCpiPositions(LIVE_CPI_POSITIONS);
    const yes38 = positions.find((position) => position.title.includes('T3.8'));
    const no40 = positions.find((position) => position.title.includes('T4.0'));
    const no41 = positions.find((position) => position.title.includes('T4.1'));
    const no42 = positions.find((position) => position.title.includes('T4.2'));

    expect(yes38.quantity).toBe(2000);
    expect(yes38.contractSide).toBe('YES');
    expect(yes38.costBasis).toBeCloseTo(1265);

    expect(no40.quantity).toBeCloseTo(427.27);
    expect(no40.contractSide).toBe('NO');
    expect(no40.costBasis).toBeCloseTo(305.6236032895);

    expect(no41.contractSide).toBe('NO');
    expect(no41.costBasis).toBeCloseTo(10.53);
    expect(no42.contractSide).toBe('NO');
    expect(no42.costBasis).toBeCloseTo(8.93);
  });

  test('uses strict greater-than for scenario probabilities', () => {
    const model = normalizeCpiNowcast(MOM_SNAPSHOT).model;
    const rows = buildCpiContractLadder([makeEvent()], model, SETTINGS);
    const row = findStrikeRow(rows, 0.3);

    expect(row.threshold).toBeCloseTo(0.3);
    expect(row.modelYesProbability).toBeCloseTo(1 / 3);
  });

  test('can produce 0%, 67%, and 100% model probabilities', () => {
    const model = normalizeCpiNowcast(MOM_SNAPSHOT).model;
    const rows = buildCpiContractLadder([
      makeEvent({ id: 'above-01', contract_title: 'Above 0.1%', question: 'CPI M/M Above 0.1%' }),
      makeEvent({ id: 'above-02', contract_title: 'Above 0.2%', question: 'CPI M/M Above 0.2%' }),
      makeEvent({ id: 'above-04', contract_title: 'Above 0.4%', question: 'CPI M/M Above 0.4%' }),
    ], model, SETTINGS);

    expect(rows.filter((row) => !row.missingContract).map((row) => row.modelYesProbability)).toEqual([1, 2 / 3, 0]);
  });

  test('uses active Kalshi CPI contracts for live ladder coverage', () => {
    const model = normalizeCpiNowcast(YOY_SNAPSHOT).model;
    const rows = buildCpiContractLadder([
      makeEvent({
        id: 'kalshi-36',
        venue: 'Kalshi',
        source_api: 'kalshi_trade_api_v2',
        underlying: 'KXCPIYOY',
        contract_title: 'Above 3.6%',
        question: 'Will CPI YoY be above 3.6%?',
        yes_bid: 0.96,
        yes_ask: 0.99,
        no_bid: 0.01,
        no_ask: 0.04,
        status: 'open',
      }),
      makeEvent({
        id: 'kalshi-37',
        venue: 'Kalshi',
        source_api: 'kalshi_trade_api_v2',
        underlying: 'KXCPIYOY',
        contract_title: 'Above 3.7%',
        question: 'Will CPI YoY be above 3.7%?',
        yes_bid: 0.76,
        yes_ask: 0.89,
        no_bid: 0.11,
        no_ask: 0.24,
        status: 'open',
      }),
      makeEvent({
        id: 'kalshi-39',
        venue: 'Kalshi',
        source_api: 'kalshi_trade_api_v2',
        underlying: 'KXCPIYOY',
        contract_title: 'Above 3.9%',
        question: 'Will CPI YoY be above 3.9%?',
        yes_bid: 0.27,
        yes_ask: 0.46,
        no_bid: 0.54,
        no_ask: 0.73,
        status: 'open',
      }),
    ], model, SETTINGS);

    expect(findStrikeRow(rows, 3.6).missingContract).toBeFalsy();
    expect(findStrikeRow(rows, 3.7).missingContract).toBeFalsy();
    expect(findStrikeRow(rows, 3.9).missingContract).toBeFalsy();
    expect(findStrikeRow(rows, 3.9).yesPrice).toBeCloseTo(0.46);
  });

  test('uses only active-month contracts when two report months share a strike', () => {
    const model = normalizeCpiNowcast(YOY_SNAPSHOT).model;
    const june = makeEvent({
      id: 'june-40',
      contract_title: 'KXCPIYOY-26JUN-T4.0_YES',
      question: 'KXCPIYOY-26JUN-T4.0_YES',
      yes_ask: 0.21,
      no_ask: 0.80,
    });
    const july = makeEvent({
      id: 'july-40',
      contract_title: 'KXCPIYOY-26JUL-T4.0_YES',
      question: 'KXCPIYOY-26JUL-T4.0_YES',
      yes_ask: 0.41,
      no_ask: 0.60,
    });
    const rows = buildCpiContractLadder([june, july], model, SETTINGS, { id: '2026-07' });
    const strikeRows = rows.filter((row) => !row.missingContract && row.threshold === 4);

    expect(strikeRows).toHaveLength(1);
    expect(strikeRows[0].event.id).toBe('july-40');
    expect(strikeRows[0].yesPrice).toBeCloseTo(0.41);
  });

  test('excludes non-live Kalshi CPI contracts from the ladder', () => {
    const model = normalizeCpiNowcast(MOM_SNAPSHOT).model;
    const kalshiCpi = makeEvent({
      id: 'kalshi:cpi-03',
      venue: 'Kalshi',
      source_api: 'kalshi_trade_api_v2',
      tradable_in_ibkr: null,
      status: 'closed',
    });

    expect(isIbkrTradableCpiEvent(kalshiCpi)).toBe(false);
    const rows = buildCpiContractLadder([kalshiCpi], model, SETTINGS);

    expect(rows).toHaveLength(7);
    expect(rows.every((row) => row.missingContract)).toBe(true);
    expect(rows.some((row) => row.event === kalshiCpi)).toBe(false);
  });

  test('selects the best positive side by net edge', () => {
    const model = normalizeCpiNowcast(MOM_SNAPSHOT).model;
    const rows = buildCpiContractLadder([
      makeEvent({ yes_ask: 0.7, no_ask: 0.2 }),
    ], model, SETTINGS);
    const row = findStrikeRow(rows, 0.3);

    expect(row.recommendedSide).toBe('NO');
    expect(row.netEdge).toBeCloseTo((2 / 3) - 0.2);
  });

  test('shows missing target strikes as non-actionable placeholders', () => {
    const model = normalizeCpiNowcast(YOY_SNAPSHOT).model;
    const rows = buildCpiContractLadder([
      makeEvent({
        id: 'above-38',
        underlying: 'KXCPIYOY',
        contract_title: 'KXCPIYOY-26JUN-T3.8_YES',
        question: 'KXCPIYOY-26JUN-T3.8_YES',
      }),
      makeEvent({
        id: 'above-40',
        underlying: 'KXCPIYOY',
        contract_title: 'KXCPIYOY-26JUN-T4.0_NO',
        question: 'KXCPIYOY-26JUN-T4.0_NO',
      }),
    ], model, SETTINGS);
    const missing = findStrikeRow(rows, 3.9);

    expect(missing.missingContract).toBe(true);
    expect(missing.yesPrice).toBeNull();
    expect(missing.noPrice).toBeNull();
    expect(missing.netEdge).toBeNull();
    expect(missing.recommendedPrice).toBeNull();
    expect(missing.executable).toBe(false);
    expect(missing.estimatedCost).toBe(0);
    expect(missing.expectedValue).toBe(0);
    expect(missing.suggestedContracts).toBe(0);
    expect(missing.warnings.join(' ')).toContain('No IBKR contract found for this target strike');
  });

  test('does not use one-sided or fallback quotes for new CPI sizing', () => {
    const model = normalizeCpiNowcast(YOY_SNAPSHOT).model;
    const rows = buildCpiContractLadder([
      makeEvent({
        id: 'one-sided-38',
        underlying: 'KXCPIYOY',
        contract_title: 'KXCPIYOY-26JUN-T3.8_YES',
        question: 'KXCPIYOY-26JUN-T3.8_YES',
        yes_bid: 0.59,
        yes_ask: null,
        yes_mid: 0.61,
        no_ask: null,
        no_bid: 0.37,
        no_mid: 0.39,
        last_price: 0.62,
        yes: 0.63,
        no: 0.37,
        volume: 10000,
      }),
    ], model, SETTINGS);
    const row = findStrikeRow(rows, 3.8);

    expect(row.missingContract).toBeFalsy();
    expect(row.yesPrice).toBeNull();
    expect(row.executable).toBe(false);
    expect(row.recommendedPrice).toBeNull();
    expect(row.netEdge).toBeNull();
    expect(row.suggestedContracts).toBe(0);
    expect(row.estimatedCost).toBe(0);
    expect(row.warnings.join(' ')).toContain('No executable ask available from IBKR');
  });

  test('does not promote out-of-grid held exposure into a contract', () => {
    const model = normalizeCpiNowcast(YOY_SNAPSHOT).model;
    const events = buildCpiEventsFromPositions([
      {
        symbol: 'KXCPIYOY',
        description: 'KXCPIYOY-26JUN-T4.5_NO',
        quantity: 10,
        price: 0.25,
        conid: 123,
      },
    ]);
    const rows = buildCpiContractLadder(events, model, SETTINGS);

    expect(events[0].tradable_in_ibkr).toBe(false);
    expect(events[0].data_quality_flags).toContain('portfolio_derived');
    expect(findStrikeRow(rows, 4.5)).toBeUndefined();
  });
});

describe('CPI sizing', () => {
  test('respects risk-capped Kelly and visible-volume liquidity caps', () => {
    const model = normalizeCpiNowcast(MOM_SNAPSHOT).model;
    const rows = buildCpiContractLadder([
      makeEvent({
        contract_title: 'Above 0.3%',
        question: 'CPI M/M Above 0.3%',
        yes_ask: 0.1,
        no_ask: 0.91,
        volume: 20,
      }),
    ], model, SETTINGS);
    const row = findStrikeRow(rows, 0.3);

    expect(row.modelYesProbability).toBeCloseTo(1 / 3);
    expect(row.suggestedContracts).toBe(1);
    expect(row.warnings.join(' ')).toContain('visible volume');
  });

  test('caps total release risk across multiple recommendations', () => {
    const model = normalizeCpiNowcast(MOM_SNAPSHOT).model;
    const rows = buildCpiContractLadder([
      makeEvent({ id: 'a', contract_title: 'Above 0.1%', question: 'CPI M/M Above 0.1%', yes_ask: 0.1, no_ask: 0.91, volume: 10000 }),
      makeEvent({ id: 'b', contract_title: 'Above 0.2%', question: 'CPI M/M Above 0.2%', yes_ask: 0.1, no_ask: 0.91, volume: 10000 }),
    ], model, { ...SETTINGS, maxRiskPerBet: 20, maxOpenRisk: 20 });

    const totalRisk = rows.reduce((sum, row) => sum + row.estimatedCost, 0);
    expect(totalRisk).toBeLessThanOrEqual(20);
  });

  test('applies missing-liquidity cap and warning', () => {
    const model = normalizeCpiNowcast(MOM_SNAPSHOT).model;
    const rows = buildCpiContractLadder([
      makeEvent({ contract_title: 'Above 0.2%', question: 'CPI M/M Above 0.2%', yes_ask: 0.1, no_ask: 0.91, volume: null }),
    ], model, { ...SETTINGS, missingLiquidityCap: 7 });
    const row = findStrikeRow(rows, 0.2);

    expect(row.suggestedContracts).toBeLessThanOrEqual(7);
    expect(row.warnings.join(' ')).toContain('Live liquidity unavailable');
  });
});

describe('summarizeCpiPositions', () => {
  test('keeps only non-zero CPI prediction positions', () => {
    const positions = summarizeCpiPositions([
      { symbol: 'CPIM JUN 0.3 YES', description: 'US CPI M/M Above 0.3%', quantity: 10, price: 0.33, averageCost: 0.25 },
      { symbol: 'SPY', description: 'S&P 500 ETF', quantity: 10, price: 500 },
      { symbol: 'CPIY ZERO', description: 'CPI position', quantity: 0, price: 0.5 },
    ]);

    expect(positions).toHaveLength(1);
    expect(positions[0].maxLoss).toBeCloseTo(2.5);
    expect(positions[0].maxProfit).toBeCloseTo(7.5);
  });

  test('keeps live IBKR KXCPIYOY positions', () => {
    const positions = summarizeCpiPositions([
      {
        symbol: 'KXCPIYOY',
        description: 'KXCPIYOY-26JUN-T4.0_NO',
        accountId: 'U25779973',
        quantity: 427.27,
        price: 0.9249888829077634,
        marketValue: 395.22,
        costBasis: 305.6236032895,
        conid: 872435582,
      },
    ]);

    expect(positions).toHaveLength(1);
    expect(positions[0].title).toBe('KXCPIYOY-26JUN-T4.0_NO');
    expect(positions[0].conid).toBe(872435582);
  });

  test('keeps CPI exposure scoped to the active report month when strikes overlap', () => {
    const positions = summarizeCpiPositions([
      {
        positionId: 'june-position',
        symbol: 'KXCPIYOY',
        description: 'KXCPIYOY-26JUN-T4.0_NO',
        quantity: 11,
        avgCost: 0.31,
      },
      {
        positionId: 'july-position',
        symbol: 'KXCPIYOY',
        description: 'KXCPIYOY-26JUL-T4.0_NO',
        quantity: 23,
        avgCost: 0.47,
      },
    ], { id: '2026-07' });

    expect(positions).toHaveLength(1);
    expect(positions[0]).toEqual(expect.objectContaining({
      id: 'july-position',
      quantity: 23,
      title: 'KXCPIYOY-26JUL-T4.0_NO',
    }));
  });

  test('derives average price from cost basis when mark is missing', () => {
    const positions = summarizeCpiPositions([
      {
        symbol: 'KXCPIYOY',
        description: 'KXCPIYOY-26JUN-T3.8_YES',
        quantity: 2000,
        price: null,
        marketValue: null,
        costBasis: 1265,
      },
    ]);

    expect(positions).toHaveLength(1);
    expect(positions[0].avgPrice).toBeCloseTo(0.6325);
    expect(positions[0].lastPrice).toBeNull();
    expect(positions[0].currentValue).toBeNull();
    expect(positions[0].maxLoss).toBeCloseTo(1265);
  });

  test('derives last price from market value when explicit mark is missing', () => {
    const positions = summarizeCpiPositions([
      {
        symbol: 'KXCPIYOY',
        description: 'KXCPIYOY-26JUN-T4.2_NO',
        quantity: 19,
        price: null,
        marketValue: 18.53,
        costBasis: 8.93,
      },
    ]);

    expect(positions[0].lastPrice).toBeCloseTo(18.53 / 19);
    expect(positions[0].avgPrice).toBeCloseTo(8.93 / 19);
    expect(positions[0].currentValue).toBeCloseTo(18.53);
  });
});
