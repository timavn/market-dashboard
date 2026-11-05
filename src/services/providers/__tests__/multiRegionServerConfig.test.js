const fs = require('fs');
const path = require('path');
const marketBackdropCatalog = require('../../../constants/marketBackdropCatalog.json');
const marketPulseSupplementalCatalog = require('../../../constants/marketPulseSupplementalCatalog.json');
const { toQuoteInstrument } = require('../multiRegionQuoteIntegrity.cjs');

const serverSource = fs.readFileSync(path.resolve(__dirname, '../../../../server.js'), 'utf8');
const catalogRows = marketBackdropCatalog.flatMap((group) => group.rows);
const catalogRow = (symbol) => catalogRows.find((row) => row.symbol === symbol);

describe('multi-region server instrument configuration', () => {
  it('fetches supplemental bond ETFs without adding them to the overview tables', () => {
    expect(marketPulseSupplementalCatalog.map((row) => row.symbol)).toEqual(['BKLN', 'MBB', 'EMB', 'TIP']);
    expect(marketPulseSupplementalCatalog.every((row) => row.label.endsWith('ETF'))).toBe(true);
    expect(marketPulseSupplementalCatalog.some((row) => catalogRow(row.symbol))).toBe(false);
    expect(serverSource).toContain("require('./src/constants/marketPulseSupplementalCatalog.json')");
    expect(serverSource).toMatch(/pulse:\s*\{\s*label: 'Macro pulse',\s*indices: MARKET_PULSE_SUPPLEMENTAL_CATALOG\.map\(toBackdropIndex\)/);
  });

  it.each(marketPulseSupplementalCatalog)('routes $symbol to its own Yahoo ETF quote', (row) => {
    expect(toQuoteInstrument({ symbol: row.symbol, ...row.provider })).toEqual(expect.objectContaining({
      symbol: row.symbol,
      provider: 'yahoo',
      yahooSymbol: row.symbol,
      secType: 'ETF',
    }));
  });

  it('uses exact IBKR cash-index identities with explicit Yahoo fallbacks', () => {
    expect(catalogRow('SPX').provider).toEqual(expect.objectContaining({
      provider: 'auto', ibkrSymbol: 'SPX', yahooSymbol: '^GSPC', conId: 416904,
    }));
    expect(catalogRow('DJI').provider).toEqual(expect.objectContaining({
      provider: 'auto', ibkrSymbol: 'INDU', yahooSymbol: '^DJI', conId: 1935181,
    }));
    expect(catalogRow('IXIC').provider).toEqual(expect.objectContaining({
      provider: 'auto', ibkrSymbol: 'COMP', yahooSymbol: '^IXIC', conId: 18342287,
    }));
    expect(catalogRow('RUT').provider).toEqual(expect.objectContaining({
      provider: 'auto', ibkrSymbol: 'RUT', yahooSymbol: '^RUT', conId: 416888,
    }));
    expect(serverSource).toContain("'SPY': 'SPY'");
    expect(serverSource).not.toContain("{ symbol: 'SPY', name: 'S&P 500', yahooSymbol: '^GSPC' }");
  });

  it('keeps USD/CAD in the requested base/quote convention', () => {
    expect(serverSource).toContain("'USDCAD': 'USDCAD=X'");
    expect(serverSource).toContain(
      "{ symbol: 'USDCAD', name: 'USD/CAD', yahooSymbol: 'USDCAD=X', provider: 'yahoo', secType: 'CASH' }"
    );
  });

  it('declares the fixed macro backdrop Yahoo identities and exact Treasury sources', () => {
    [
      "'SMH': 'SMH'",
      "'STOXX600': '^STOXX'",
      "'SX5E': '^STOXX50E'",
      "'CSI300': '000300.SS'",
      "'KOSPI': '^KS11'",
      "'TAIEX': '^TWII'",
      "'NIFTY50': '^NSEI'",
      "'JKSE': '^JKSE'",
      "'KLSE': '^KLSE'",
      "'NG': 'NG=F'",
      "'ZC': 'ZC=F'",
      "'PA': 'PA=F'",
      "'ZW': 'ZW=F'",
      "'ZS': 'ZS=F'",
      "'RB': 'RB=F'",
      "'BNB': 'BNB-USD'",
      "'XRP': 'XRP-USD'",
      "'ADA': 'ADA-USD'",
      "'UST2Y': 'DGS2'",
    ].forEach((mapping) => expect(serverSource).toContain(mapping));
    expect(serverSource).not.toContain("'UST2Y': '^FVX'");
    expect(catalogRow('CURVE_2s10s')).toEqual(expect.objectContaining({
      unit: 'bps',
      changeUnit: 'bps',
      derived: { formula: ['UST10Y', 'UST2Y'] },
    }));
  });

  it('declares commodity and crypto rows as non-equity provider descriptors', () => {
    expect(catalogRow('BZ').provider).toEqual(expect.objectContaining({
      yahooSymbol: 'BZ=F', provider: 'yahoo', secType: 'FUT',
    }));
    expect(catalogRow('BTC').provider).toEqual(expect.objectContaining({
      yahooSymbol: 'BTC-USD', provider: 'yahoo', secType: 'CRYPTO',
    }));
    expect(catalogRow('ADA').provider).toEqual(expect.objectContaining({
      yahooSymbol: 'ADA-USD', provider: 'yahoo', secType: 'CRYPTO',
    }));
  });

  it.each([
    ['XLF', 'XLF', 'ETF'],
    ['VNQ', 'VNQ', 'ETF'],
    ['DOGE', 'DOGE-USD', 'CRYPTO'],
    ['LINK', 'LINK-USD', 'CRYPTO'],
    ['TRX', 'TRX-USD', 'CRYPTO'],
  ])('keeps the added %s row tied to its own provider identity', (symbol, yahooSymbol, secType) => {
    expect(catalogRow(symbol).provider).toEqual({ provider: 'yahoo', yahooSymbol, secType });
  });

  it('expands US to every sector SPDR, with VNQ standing in for XLRE', () => {
    const usSymbols = marketBackdropCatalog.find((group) => group.id === 'us').rows.map((row) => row.symbol);
    ['XLK', 'XLC', 'XLY', 'XLF', 'XLV', 'XLI', 'XLE', 'XLB', 'XLP', 'XLU', 'VNQ']
      .forEach((symbol) => expect(usSymbols).toContain(symbol));
    expect(usSymbols).not.toContain('XLRE');
  });

  it('preserves the expanded catalog: eight rows in the top cards, nine in Commodities, Rates and Crypto', () => {
    expect(catalogRows).toHaveLength(73);
    expect(catalogRows.filter((row) => row.summary)).toHaveLength(51);
    expect(new Set(catalogRows.map((row) => row.symbol)).size).toBe(73);
    marketBackdropCatalog.forEach((group) => {
      expect(group.rows.filter((row) => row.summary)).toHaveLength(['commodities', 'rates', 'crypto'].includes(group.id) ? 9 : 8);
    });
    expect(catalogRows.some((row) => ['UST5Y', 'CGB10Y'].includes(row.symbol)))
      .toBe(false);
  });

  it('keeps the overview instruments per card with related commodities grouped together', () => {
    const summarySymbolsByGroup = Object.fromEntries(marketBackdropCatalog.map((group) => [
      group.id,
      group.rows.filter((row) => row.summary).map((row) => row.symbol),
    ]));

    expect(summarySymbolsByGroup).toEqual({
      us: ['SPX', 'RSP', 'MID', 'RUT', 'NDX', 'SMH', 'XLF', 'VNQ'],
      europe: ['STOXX600', 'SX5E', 'FTSE', 'DAX', 'CAC', 'FTSEMIB', 'IBEX', 'SMI'],
      asia: ['N225', 'HSI', 'CSI300', 'NIFTY50', 'KOSPI', 'TAIEX', 'AXJO', 'JKSE'],
      commodities: ['CRB', 'CL', 'BZ', 'NG', 'GC', 'SI', 'HG', 'ZC', 'ZS'],
      rates: ['UST2Y', 'UST10Y', 'UST30Y', 'BUND10Y', 'JGB10Y', 'GILT10Y', 'CURVE_2s10s', 'IG_OAS', 'HY_OAS'],
      crypto: ['BTC', 'ETH', 'BNB', 'XRP', 'SOL', 'ADA', 'DOGE', 'LINK', 'TRX'],
    });
  });
});
