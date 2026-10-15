const test = require('node:test');
const assert = require('node:assert/strict');
const { MARKETS, buildPredictionAnalysis } = require('./analystPredictions.cjs');
const NOW = new Date('2026-08-20T13:30:00.000Z');
const AS_OF = '2026-08-20T13:29:30.000Z';
const EXPIRES = '2026-08-20T13:31:00.000Z';
const CLOSE = '2026-08-20T20:00:00.000Z';

function directLine(overrides = {}) {
  return {
    ticker: 'LINE-100',
    threshold: 100,
    comparator: '>',
    status: 'available',
    yesBid: 0.40,
    yesAsk: 0.42,
    yesBidSize: 10,
    yesAskSize: 12,
    noBid: 0.58,
    noAsk: 0.60,
    noBidSize: 11,
    noAskSize: 13,
    volume24h: 123,
    openInterest: 45,
    updatedAt: AS_OF,
    source: 'kalshi_trade_api_v2',
    directNative: true,
    ...overrides,
  };
}

function snapshot(marketId, overrides = {}) {
  const line = directLine();
  const event = {
    ticker: `${marketId.toUpperCase()}-EVENT`,
    seriesTicker: `${marketId.toUpperCase()}-SERIES`,
    title: `${marketId} event`,
    status: 'open',
    closeTime: CLOSE,
    availableOnBrokers: true,
    brokerRoutable: true,
  };
  return {
    schemaVersion: 2,
    marketId,
    generatedAt: AS_OF,
    status: 'partial',
    spot: {
      status: 'available', availability: 'live', fit: 'exact', value: 101,
      source: 'resolver', asOf: AS_OF, expiresAt: EXPIRES,
    },
    riskRange: {
      status: 'available', lrr: 100, hrr: 130, previousClose: 105, trend: 'BULLISH', fit: 'calibration',
      ticker: 'TEST', date: '2026-08-20', source: 'risk-ranges', asOf: AS_OF, expiresAt: EXPIRES,
    },
    factors: {
      trade: {
        status: 'available', direction: 'BULLISH', raw: 'BULLISH', date: '2026-08-20',
        ticker: 'TEST', source: 'momo-tracker', asOf: AS_OF, expiresAt: EXPIRES,
      },
      usd: {
        status: 'available', r15: -0.2, r30: -0.5, r90: 0.1,
        source: 'DXY', asOf: AS_OF, expiresAt: EXPIRES,
      },
      cftc: {
        status: 'available', zScore1Y: -1.25, zScore3Y: -0.75,
        source: 'cftc', asOf: '2026-08-14', expiresAt: EXPIRES,
      },
    },
    displayContracts: {
      status: 'available', source: 'kalshi_trade_api_v2_catalog', asOf: AS_OF,
      expiresAt: CLOSE, event, lines: [line, directLine({ ticker: 'LINE-110', threshold: 110 })],
    },
    autoSelection: {
      status: 'available', venueId: 'kalshi', reason: null,
      contracts: {
        status: 'available', source: 'kalshi_trade_api_v2', asOf: AS_OF,
        expiresAt: EXPIRES, event, lines: [line],
      },
    },
    venues: {
      kalshi: {
        brokerRoutable: true,
        bookQuality: { eligible: true },
      },
    },
    strategy: {
      status: 'available', model: 'validated-test-model', eligibleVenueId: 'kalshi', reason: null,
    },
    ...overrides,
  };
}


function inputs() {
 const markets = MARKETS.map(([marketId,,venue]) => {
  const s = snapshot(marketId);
  s.selectedVenueId = venue;
  s.autoSelection.venueId = venue;
  s.venues[venue] = { brokerRoutable: true, bookQuality: { eligible: true } };
  s.displayContracts.lines = [directLine({ticker: `${marketId}-100`, threshold:100, feePerContract:0.01, yesAskSize:100000})];
  s.autoSelection.contracts = s.displayContracts;
  if (marketId === 'cpi') s.forecastComparison = { releaseKey:'2026-08-CPI', hedgeye:{status:'unavailable'} };
  return {marketId,snapshot:s};
 });
 return { markets, portfolio:{liveVerified:true,freshness:'live',asOf:AS_OF}, metrics:{available:true,accountSummaryAvailable:true,netLiquidation:100000,positions:[]}, balance:{liveVerified:true,freshness:'live_with_dated_verified_history',asOf:AS_OF,data:{current:{capacity:{available:true,status:'live'},eventContracts:{availableFunds:100000,verification:'ibkr_event_contract_commodity_segment_reconciled'}}}} };
}
test('six requested markets keep exact venue order and existing research screens', async()=>{
 const report=await buildPredictionAnalysis(inputs(),+NOW);
 assert.deepEqual(MARKETS, [['cpi','CPI','forecastex'], ['sp500','S&P 500','forecastex'], ['gold','Gold','kalshi'], ['silver','Silver','kalshi'], ['bitcoin','Bitcoin','kalshi'], ['ethereum','Ethereum','kalshi']]);
 for(const row of report.markets.filter(row => row.marketId !== 'cpi')) {
  assert.equal(row.status,'qualified',JSON.stringify(row.reasons));
  assert.ok(row.candidates[0].sizing.combinedLoss<=5000);
  assert.ok(row.candidates[0].sizing.contracts>0);
 }
 assert.equal(report.markets.find(row => row.marketId === 'cpi').status,'withheld');
});
test('S&P 500 uses pinned ForecastEx and related-index ranges cannot qualify contract sizing', async()=>{
 const input=inputs();
 const nasdaq=input.markets.find(row=>row.marketId==='sp500');
 assert.deepEqual(MARKETS.find(([id])=>id==='sp500'),['sp500','S&P 500','forecastex']);
 nasdaq.snapshot.riskRange.fit='related_only';
 nasdaq.snapshot.riskRange.ticker='COMPQ';
 const row=(await buildPredictionAnalysis(input,+NOW)).markets.find(market=>market.marketId==='sp500');
 assert.equal(row.normalized.riskRange.setupEligible,false);
 assert.equal(row.status,'withheld');
 assert.deepEqual(row.candidates,[]);
 for(const mutation of [{selectedVenueId:'kalshi'}, {displayContracts:{status:'unavailable'}},
  {displayContracts:{...nasdaq.snapshot.displayContracts,refreshFailed:true}}]) {
  const unavailable=structuredClone(input);
  Object.assign(unavailable.markets.find(market=>market.marketId==='sp500').snapshot,mutation);
  const result=(await buildPredictionAnalysis(unavailable,+NOW)).markets.find(market=>market.marketId==='sp500');
  assert.equal(result.status,'withheld');
  assert.deepEqual(result.candidates,[]);
 }
});
test('new Silver analysis uses pinned Kalshi and rejects a ForecastEx substitution', async()=>{
 const input=inputs();
 assert.deepEqual(MARKETS.find(([id])=>id==='silver'),['silver','Silver','kalshi']);
 const silver=(await buildPredictionAnalysis(input,+NOW)).markets.find(row=>row.marketId==='silver');
 assert.equal(silver.venue,'kalshi');
 assert.equal(silver.status,'qualified');
 input.markets.find(row=>row.marketId==='silver').snapshot.selectedVenueId='forecastex';
 const rejected=(await buildPredictionAnalysis(input,+NOW)).markets.find(row=>row.marketId==='silver');
 assert.equal(rejected.status,'withheld');
 assert.deepEqual(rejected.candidates,[]);
});
test('existing exposure and both proposed lines share one cap; live outages withhold',async()=>{
 const input=inputs();
 input.metrics.positions=[{symbol:'gold-100',conId:'gold-100',category:'event_contract',quantity:100,costBasis:4900}];
 input.markets.find(row=>row.marketId==='gold').snapshot.displayContracts.lines.push(directLine({ticker:'gold-99',threshold:99,yesAskSize:100000}));
 const report=await buildPredictionAnalysis(input,+NOW);
 const gold=report.markets.find(row=>row.marketId==='gold');
 assert.ok(gold.candidates.reduce((s,c)=>s+(c.sizing.proposedLoss||0),4900)<=5000);
 input.portfolio.liveVerified=false;
 const unavailable=await buildPredictionAnalysis(input,+NOW);
 assert.equal(unavailable.totalProposedLoss,0);
 assert.ok(unavailable.markets.every(m=>m.status!=='qualified'));
});
test('screen includes eligible lines outside the five-line display focus',async()=>{
 const input=inputs(); const s=input.markets.find(row=>row.marketId==='gold').snapshot;
 s.displayContracts.lines=[...Array.from({length:6},(_,i)=>directLine({ticker:`middle-${i}`,threshold:110+i,yesAsk:.51,yesBid:.49})),directLine({ticker:'gold-low',threshold:99,yesBid:.8,yesAsk:.82,yesAskSize:1000})];
 const report=await buildPredictionAnalysis(input,+NOW);
 assert.equal(report.markets.find(row=>row.marketId==='gold').candidates[0].contractId,'gold-low');
});

const MODEL = {
  metric: 'Headline CPI YoY',
  forecastMonth: 'July 2026',
  scenarios: [
    { key: 'downside', label: 'Downside', value: 3.37 },
    { key: 'base', label: 'Base Case', value: 3.48 },
    { key: 'upside', label: 'Upside', value: 3.59 },
  ],
};

const HISTORICAL = [
  ['2025-07', 2.49, 2.60, 2.72, 2.7],
  ['2025-08', 2.71, 2.83, 2.94, 2.9],
  ['2025-09', 2.99, 3.10, 3.21, 3.0],
  ['2025-11', 2.93, 3.04, 3.15, 2.7],
  ['2025-12', 2.45, 2.56, 2.67, 2.7],
  ['2026-01', 2.39, 2.50, 2.61, 2.4],
  ['2026-02', 2.33, 2.44, 2.55, 2.4],
  ['2026-03', 3.20, 3.31, 3.42, 3.3],
  ['2026-04', 3.51, 3.62, 3.73, 3.8],
  ['2026-05', 4.13, 4.24, 4.35, 4.2],
  ['2026-06', 3.72, 3.83, 3.94, 3.5],
];

const HISTORY = {
  entries: HISTORICAL.map(([monthId, lower, base, upper]) => ({
    monthId,
    status: 'final-pre-release',
    scenarios: {
      lower: { raw: lower, rounded: Number(lower.toFixed(1)) },
      base: { raw: base, rounded: Number(base.toFixed(1)) },
      upper: { raw: upper, rounded: Number(upper.toFixed(1)) },
    },
  })),
};

const FINALS = HISTORICAL.map(([id, , , , value]) => ({ id, value }));


test('ForecastEx CPI never receives the Kalshi calibration, native quotes, or fees',async()=>{
 const input=inputs(); const s=input.markets.find(row=>row.marketId==='cpi').snapshot;
 s.forecastComparison.hedgeye={status:'available',scenarios:MODEL.scenarios};
 s.forecastComparison.metric=MODEL.metric; s.forecastComparison.releaseAt=CLOSE;
 input.cpi={history:HISTORY,finals:FINALS};
 s.displayContracts.lines=[.94,.76,.55,.34,.17,.08,.03].map((ask,i)=>directLine({ticker:`cpi-${i}`,threshold:3.2+i/10,yesAsk:ask,yesBid:Math.max(.01,ask-.02),noBid:1-ask,noAsk:Math.min(.99,1-Math.max(.01,ask-.02)),yesAskSize:10000,noAskSize:10000}));
 const report=await buildPredictionAnalysis(input,+NOW); const cpi=report.markets.find(row=>row.marketId==='cpi');
 assert.equal(cpi.status,'withheld');
 assert.equal(cpi.allocation,undefined);
 assert.deepEqual(cpi.candidates,[]);
 assert.match(cpi.reasons.join(' '),/ForecastEx CPI allocation is not supported/);
 s.selectedVenueId='kalshi';
 const rejected=(await buildPredictionAnalysis(input,+NOW)).markets.find(row=>row.marketId==='cpi');
 assert.equal(rejected.status,'withheld');
 assert.equal(rejected.allocation,undefined);
 assert.deepEqual(rejected.candidates,[]);
});
