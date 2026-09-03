const fs = require('fs');
const path = require('path');

const serverSource = fs.readFileSync(path.resolve(__dirname, '../../../../server.js'), 'utf8');

describe('multi-region server instrument configuration', () => {
  it('uses exact IBKR cash-index identities with explicit Yahoo fallbacks', () => {
    [
      "{ symbol: 'SPX', name: 'S&P 500', ibkrSymbol: 'SPX', yahooSymbol: '^GSPC', provider: 'auto', conId: 416904, secType: 'IND', exchange: 'CBOE', currency: 'USD' }",
      "{ symbol: 'DJI', name: 'Dow 30', ibkrSymbol: 'INDU', yahooSymbol: '^DJI', provider: 'auto', conId: 1935181, secType: 'IND', exchange: 'CME', currency: 'USD' }",
      "{ symbol: 'IXIC', name: 'Nasdaq', ibkrSymbol: 'COMP', yahooSymbol: '^IXIC', provider: 'auto', conId: 18342287, secType: 'IND', exchange: 'NASDAQ', currency: 'USD' }",
      "{ symbol: 'RUT', name: 'Russell 2000', ibkrSymbol: 'RUT', yahooSymbol: '^RUT', provider: 'auto', conId: 416888, secType: 'IND', exchange: 'RUSSELL', currency: 'USD' }",
    ].forEach((descriptor) => expect(serverSource).toContain(descriptor));
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
      "'NG': 'NG=F'",
      "'ZC': 'ZC=F'",
      "'BNB': 'BNB-USD'",
      "'XRP': 'XRP-USD'",
      "'UST2Y': 'DGS2'",
    ].forEach((mapping) => expect(serverSource).toContain(mapping));
    expect(serverSource).not.toContain("'UST2Y': '^FVX'");
    expect(serverSource).toContain(
      "{ symbol: 'CURVE_2s10s', name: '2s10s', unit: 'bps', formula: ['UST10Y', 'UST2Y'] }"
    );
  });

  it('declares commodity and crypto rows as non-equity provider descriptors', () => {
    expect(serverSource).toContain(
      "{ symbol: 'BZ', name: 'Brent Crude', yahooSymbol: 'BZ=F', provider: 'yahoo', secType: 'FUT' }"
    );
    expect(serverSource).toContain(
      "{ symbol: 'BTC', name: 'Bitcoin', yahooSymbol: 'BTC-USD', provider: 'yahoo', secType: 'CRYPTO' }"
    );
  });
});
