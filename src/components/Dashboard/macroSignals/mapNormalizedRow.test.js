import { mapNormalizedRowToMacroSignal } from './mapNormalizedRow';

describe('mapNormalizedRowToMacroSignal', () => {
  test('derives side from riskTrend when composite trend is null', () => {
    const view = mapNormalizedRowToMacroSignal({
      symbol: 'MSFT',
      label: 'Microsoft',
      group: 'Index',
      trend: null,
      riskTrend: 'BULLISH',
      lrr: 400,
      hrr: 450,
      score: 80,
    });
    expect(view.side).toBe('long');
    expect(view.forecastLow).toBe(400);
    expect(view.forecastHigh).toBe(450);
  });

  test('leaves side null for NEUTRAL riskTrend with range data', () => {
    const view = mapNormalizedRowToMacroSignal({
      symbol: 'XLK',
      label: 'Technology',
      group: 'Index',
      trend: null,
      riskTrend: 'NEUTRAL',
      lrr: 200,
      hrr: 220,
      score: 40,
    });
    expect(view.side).toBeNull();
    expect(view.forecastLow).toBe(200);
  });

  test('computes upside and downside percent from lrr/hrr and reference price', () => {
    const view = mapNormalizedRowToMacroSignal({
      symbol: 'MSTR',
      label: 'MicroStrategy',
      group: 'Index',
      riskTrend: 'BEARISH',
      lrr: 148,
      hrr: 172,
      price: 167,
      prevClose: 165,
      quoteSource: 'yahoo',
    });
    expect(view.referencePrice).toBe(167);
    expect(view.upsidePct).toBeCloseTo(2.99, 1);
    expect(view.downsidePct).toBeCloseTo(-11.38, 1);
  });

  test('FI tab bond ETF maps to Credit asset class', () => {
    const view = mapNormalizedRowToMacroSignal({
      symbol: 'LQD',
      label: 'Investment Grade Corporate Bonds (LQD)',
      group: 'Credit',
      riskTrend: 'BEARISH',
      lrr: 107.3,
      hrr: 108.6,
      price: 107.12,
      prevClose: 107.0,
    });
    expect(view.assetClass).toBe('FI');
    expect(view.forecastLow).toBe(107.3);
  });

  test('uses previous close as reference when spot equals close', () => {
    const view = mapNormalizedRowToMacroSignal({
      symbol: 'SPX',
      label: 'S&P 500',
      group: 'Index',
      riskTrend: 'BULLISH',
      lrr: 4800,
      hrr: 5000,
      price: 4900,
      prevClose: 4900,
    });
    expect(view.referencePrice).toBe(4900);
    expect(view.upsidePct).toBeCloseTo(2.04, 1);
    expect(view.downsidePct).toBeCloseTo(-2.04, 1);
  });
});
