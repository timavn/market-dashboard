const fs = require('fs');
const path = require('path');

const serverSource = fs.readFileSync(path.resolve(__dirname, '../../../../server.js'), 'utf8');

describe('multi-region server instrument configuration', () => {
  it('uses the SPX cash index identity instead of labeling SPY as the index', () => {
    expect(serverSource).toContain(
      "{ symbol: 'SPX', name: 'S&P 500', yahooSymbol: '^GSPC', provider: 'yahoo', secType: 'IND' }"
    );
    expect(serverSource).toContain("'SPY': 'SPY'");
    expect(serverSource).not.toContain("{ symbol: 'SPY', name: 'S&P 500', yahooSymbol: '^GSPC' }");
  });

  it('keeps USD/CAD in the requested base/quote convention', () => {
    expect(serverSource).toContain("'USDCAD': 'USDCAD=X'");
    expect(serverSource).toContain(
      "{ symbol: 'USDCAD', name: 'USD/CAD', yahooSymbol: 'USDCAD=X', provider: 'yahoo', secType: 'CASH' }"
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
