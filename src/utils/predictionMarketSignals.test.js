import {
  collectMacroSignalSymbols,
  getMacroSignalQuotePlan,
  inferPredictionSignalCategory,
  normalizePredictionMarketSignals,
  resolveMacroSignalQuoteSymbol,
} from './predictionMarketSignals';
import { mapNormalizedRowToMacroSignal } from '../components/Dashboard/macroSignals/mapNormalizedRow';

describe('resolveMacroSignalQuoteSymbol', () => {
  test('quotes RUT index when IWM row uses RUT risk range', () => {
    expect(resolveMacroSignalQuoteSymbol('IWM', 'RUT')).toBe('RUT');
  });

  test('quotes IWM ETF when risk range is stored under IWM directly', () => {
    expect(resolveMacroSignalQuoteSymbol('IWM', 'IWM')).toBe('IWM');
  });

  test('quotes NDX index when QQQ row uses NDX risk range', () => {
    expect(resolveMacroSignalQuoteSymbol('QQQ', 'NDX')).toBe('NDX');
  });

  test('quotes QQQ ETF when risk range is stored under QQQ directly', () => {
    expect(resolveMacroSignalQuoteSymbol('QQQ', 'QQQ')).toBe('QQQ');
  });
});

describe('getMacroSignalQuotePlan', () => {
  test('maps IWM display to RUT quote when ranges keyed as RUT', () => {
    const plan = getMacroSignalQuotePlan({
      RUT: { lrr: 2100, hrr: 2200, trend: 'BULLISH', date: '2026-05-19' },
    });
    expect(plan).toContainEqual({ display: 'IWM', quote: 'RUT' });
  });

  test('maps QQQ display to NDX quote when ranges keyed as NDX', () => {
    const plan = getMacroSignalQuotePlan({
      NDX: { lrr: 21000, hrr: 22000, trend: 'BULLISH', date: '2026-05-19' },
    });
    expect(plan).toContainEqual({ display: 'QQQ', quote: 'NDX' });
  });
});

describe('inferPredictionSignalCategory', () => {
  test('uses the active filter when set', () => {
    expect(inferPredictionSignalCategory('Rates', { question: 'Bitcoin above 100k?' })).toBe('Rates');
  });

  test('infers crypto from the selected event text', () => {
    expect(inferPredictionSignalCategory('all', { question: 'Will Bitcoin close above $100,000?' })).toBe('Crypto');
  });
});

describe('normalizePredictionMarketSignals', () => {
  test('merges Bitcoin tracker and risk ranges for crypto rows', () => {
    const result = normalizePredictionMarketSignals({
      activeCategory: 'Crypto',
      riskRanges: {
        BTC: { lrr: 100000, hrr: 110000, trend: 'BULLISH', date: '2026-05-16' },
      },
      bitcoinSnapshot: {
        date: '2026-05-16',
        data: {
          cryptos: {
            BTC: { price: 105000, buyTrade: 101000, sellTrade: 112000, trend: 'BULLISH' },
          },
        },
      },
    });

    expect(result.category).toBe('Crypto');
    expect(result.rows).toHaveLength(4);
    expect(result.rows[0]).toMatchObject({
      symbol: 'BTC',
      trend: 'BULLISH',
      lrr: 100000,
      hrr: 110000,
      buyTrade: 101000,
      sellTrade: 112000,
    });
  });


  test('resolves BTC from BITCOIN risk range keys', () => {
    const result = normalizePredictionMarketSignals({
      activeCategory: 'Crypto',
      riskRanges: {
        BITCOIN: { lrr: 75637, hrr: 82531, trend: 'BULLISH', date: '2026-05-19' },
      },
    });
    const btc = result.rows.find(r => r.symbol === 'BTC');
    expect(btc).toMatchObject({ lrr: 75637, hrr: 82531, riskTrend: 'BULLISH' });
  });

  test('includes risk-range-only tickers from uploads', () => {
    const result = normalizePredictionMarketSignals({
      activeCategory: 'all',
      riskRanges: {
        RUT: { lrr: 2100, hrr: 2200, trend: 'BULLISH', date: '2026-05-19' },
        XLK: { lrr: 200, hrr: 220, trend: 'NEUTRAL', date: '2026-05-19' },
        MSFT: { lrr: 400, hrr: 450, trend: 'BULLISH', date: '2026-05-19' },
        UST10Y: { lrr: 4.2, hrr: 4.7, trend: 'BEARISH', date: '2026-05-19' },
        BITCOIN: { lrr: 75000, hrr: 82000, trend: 'BULLISH', date: '2026-05-19' },
      },
    });

    const symbols = result.rows.map(row => row.symbol);
    expect(symbols).toContain('IWM');
    expect(symbols).toContain('XLK');
    expect(symbols).toContain('MSFT');
    expect(symbols).toContain('UST10Y');
    expect(symbols).toContain('BTC');
    expect(symbols).not.toContain('BITCOIN');

    const iwm = result.rows.find(r => r.symbol === 'IWM');
    expect(iwm).toMatchObject({ lrr: 2100, hrr: 2200, riskTrend: 'BULLISH' });
  });

  test('carries prevClose and quoteSource from spotPrices', () => {
    const result = normalizePredictionMarketSignals({
      activeCategory: 'all',
      riskRanges: {
        SPX: { lrr: 4800, hrr: 5000, trend: 'BULLISH', date: '2026-05-19' },
      },
      spotPrices: {
        SPX: { price: '4910.00', previousClose: '4900.00', source: 'ibkr' },
      },
    });
    const spx = result.rows.find(r => r.symbol === 'SPX');
    expect(spx.prevClose).toBe(4900);
    expect(spx.quoteSource).toBe('ibkr');
    expect(spx.price).toBe(4910);
  });

  test('uses index-scale spot remapped onto IWM when RUT range is present', () => {
    const result = normalizePredictionMarketSignals({
      activeCategory: 'all',
      riskRanges: {
        RUT: { lrr: 2100, hrr: 2200, trend: 'BULLISH', date: '2026-05-19' },
      },
      spotPrices: {
        IWM: { price: 273.5 },
      },
    });
    const iwm = result.rows.find(r => r.symbol === 'IWM');
    const view = mapNormalizedRowToMacroSignal(iwm);
    expect(view.spotPrice).toBe(273.5);
    expect(view.forecastLow).toBe(2100);
    expect(view.forecastHigh).toBe(2200);
  });

  test('collectMacroSignalSymbols dedupes aliases', () => {
    const symbols = collectMacroSignalSymbols({
      BITCOIN: { lrr: 1, hrr: 2 },
      RUT: { lrr: 1, hrr: 2 },
    });
    expect(symbols).toContain('BTC');
    expect(symbols).toContain('IWM');
    expect(symbols).not.toContain('BITCOIN');
    expect(symbols).not.toContain('RUT');
  });

  test('uses a broad macro universe for inflation events', () => {
    const result = normalizePredictionMarketSignals({
      activeCategory: 'Inflation',
      riskRanges: {
        GOLD: { lrr: 3000, hrr: 3300, trend: 'BULLISH' },
        UST10Y: { lrr: 4.2, hrr: 4.7, trend: 'BEARISH' },
      },
    });

    const symbols = result.rows.map(row => row.symbol);
    expect(symbols).toContain('GOLD');
    expect(symbols).toContain('UST10Y');
    expect(symbols).toContain('SPX');
    expect(symbols).not.toContain('BTC');
  });
});

describe('macro signal view mapping', () => {
  test('NEUTRAL risk rows map to null side for neutral UI section', () => {
    const result = normalizePredictionMarketSignals({
      activeCategory: 'all',
      riskRanges: {
        XLK: { lrr: 200, hrr: 220, trend: 'NEUTRAL', date: '2026-05-19' },
      },
    });
    const row = result.rows.find(r => r.symbol === 'XLK');
    const view = mapNormalizedRowToMacroSignal(row);
    expect(view.side).toBeNull();
    expect(view.forecastLow).toBe(200);
  });
});
