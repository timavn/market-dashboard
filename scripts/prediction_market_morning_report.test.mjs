import assert from 'node:assert/strict';
import test from 'node:test';

import { formatMorningReport } from './prediction_market_morning_report.mjs';

function unavailable(reason) {
  return { status: 'unavailable', reason };
}

function market(marketId) {
  return {
    marketId,
    catalog: {
      status: 'available',
      contractCount: 12,
      event: { ticker: `${marketId}-EVENT`, title: `${marketId} event`, closeTime: '2026-08-20T20:00:00Z' },
    },
    directBook: unavailable('No verified direct native book is available.'),
    riskRange: {
      status: 'available', lrr: 100, hrr: 130, buyTrade: 100, sellTrade: 130,
      trend: 'BULLISH', date: '2026-08-20', asOf: '2026-08-20T13:00:00Z',
    },
    trade: { status: 'available', direction: 'BULLISH' },
    bias: { aligned: true },
    rangePosition: {
      status: 'available', value: 105, zone: 'LRR', positionPct: 16.7,
      referenceLabel: 'RR close', distanceToLrr: 5, distanceToHrr: 25,
    },
    usdCorrelation: { status: 'available', r30: -0.5, asOf: '2026-08-20T13:00:00Z' },
    cftcZScore: { status: 'available', zScore1Y: 1.2, asOf: '2026-08-15T00:00:00Z' },
    setup: {
      researchQualified: true,
      rankEligible: false,
      pattern: 'BULLISH_AT_LRR',
      reasons: ['No verified direct native book is available.'],
    },
  };
}

function report() {
  return {
    reportType: 'four_market_morning',
    generatedAt: '2026-08-20T13:01:00Z',
    asOf: '2026-08-20T13:00:00Z',
    marketOrder: ['sp500', 'wti', 'nasdaq100', 'gold'],
    markets: ['sp500', 'wti', 'nasdaq100', 'gold'].map(market),
    summary: {
      currentCatalogCount: 4,
      verifiedDirectBookCount: 0,
      executionVerifiedCount: 0,
      matchedSetupCount: 4,
      rankEligibleCount: 0,
    },
  };
}

test('formatter preserves exact section order and never prints catalog prices or event aggregates', () => {
  const markdown = formatMorningReport(report(), {
    status: 'ready',
    lastSyncAt: '2026-08-20T13:00:00Z',
    latestRiskRangesDate: '2026-08-20',
  });
  const headings = [...markdown.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(headings, ['S&P 500', 'WTI', 'Nasdaq 100', 'Gold']);
  assert.match(markdown, /Buy Trade 100 \/ Sell Trade 130; Trend BULLISH/);
  assert.match(markdown, /RR close 105 is in the LRR zone \(16\.7% of range\)/);
  assert.match(markdown, /Current Yes\/No pricing unavailable/);
  assert.doesNotMatch(markdown, /24h volume|open interest|Yes \d+¢/);
  assert.match(markdown, /not rank-eligible/);
  assert.match(markdown, /0\/4 verified direct books/);
});

test('formatter shows line-specific prices and rank status only for an eligible direct book', () => {
  const payload = report();
  payload.markets[0].directBook = {
    status: 'available',
    venueId: 'kalshi',
    asOf: '2026-08-20T13:00:30Z',
    lineCount: 1,
    focusLines: [{
      ticker: 'KXINXU-26AUG20-T7700', threshold: 7700, comparator: 'greater_than',
      yesBid: 0.41, yesAsk: 0.43, noBid: 0.56, noAsk: 0.58,
      volume24h: 1234, openInterest: 5678,
    }],
  };
  payload.markets[0].setup.rankEligible = true;
  payload.summary.verifiedDirectBookCount = 1;
  payload.summary.rankEligibleCount = 1;

  const markdown = formatMorningReport(payload);

  assert.match(markdown, /KXINXU-26AUG20-T7700.*Yes 41¢–43¢, No 56¢–58¢; 24h volume 1,234; open interest 5,678\./s);
  assert.match(markdown, /Rank-eligible research screen: BULLISH_AT_LRR/);
  assert.match(markdown, /no trade recommendation/i);
});

test('formatter rejects a reordered or incomplete packet', () => {
  const payload = report();
  payload.marketOrder = ['wti', 'sp500', 'nasdaq100', 'gold'];
  assert.throws(() => formatMorningReport(payload), /market order is invalid/);
});

test('formatter never coerces missing metrics to zero', () => {
  const payload = report();
  payload.markets[0].catalog.contractCount = null;
  payload.markets[0].usdCorrelation.r30 = null;
  payload.markets[0].cftcZScore.zScore1Y = null;

  const markdown = formatMorningReport(payload);

  assert.match(markdown, /unavailable catalog contracts/);
  assert.match(markdown, /Dollar correlation:\*\* r30 unavailable/);
  assert.match(markdown, /CFTC z-score:\*\* 1Y unavailable/);
  assert.doesNotMatch(markdown, /Dollar correlation:\*\* r30 \+?0\.00/);
  assert.doesNotMatch(markdown, /CFTC z-score:\*\* 1Y \+?0\.00/);
});
