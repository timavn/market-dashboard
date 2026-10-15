// Interpretation references only. None of these rows defines a PCA training
// column, a quad factor, a holding proxy, or an executable quote.
const CATALOG_VERSION = 'pca-macro-references-v1';
const etf = (symbol, label, group, issuerUrl) => Object.freeze({
  id: symbol, symbol, label, group, provider: 'yahoo',
  transform: 'adjusted_return', currency: 'USD', issuerUrl,
});
const STATE_STREET = 'https://www.ssga.com/us/en/individual/capabilities/equities/sector-investing/select-sector-etfs';
const ISHARES = 'https://www.ishares.com/us/products/etf-investments';
const INVESCO = 'https://www.invesco.com/us/en/solutions/invesco-etfs.html';
const ETF_REFERENCES = Object.freeze([
  etf('SPY', 'US large-cap equities ETF', 'Equities', 'https://www.ssga.com/us/en/individual/etfs/spdr-sp-500-etf-trust-spy'),
  etf('QQQ', 'Nasdaq 100 ETF', 'Equities', 'https://www.invesco.com/qqq-etf/en/home.html'),
  etf('IWM', 'US small-cap equities ETF', 'Equities', ISHARES),
  etf('EFA', 'Developed ex-US equities ETF', 'Equities', ISHARES),
  etf('EEM', 'Emerging-market equities ETF', 'Equities', ISHARES),
  ...[
    ['XLC', 'Communication services'], ['XLY', 'Consumer discretionary'],
    ['XLP', 'Consumer staples'], ['XLE', 'Energy'], ['XLF', 'Financials'],
    ['XLV', 'Health care'], ['XLI', 'Industrials'], ['XLB', 'Materials'],
    ['XLRE', 'Real estate'], ['XLK', 'Technology'], ['XLU', 'Utilities'],
  ].map(([symbol, label]) => etf(symbol, `${label} ETF`, 'Sectors', STATE_STREET)),
  ...[
    ['SHY', 'Short Treasury'], ['IEF', 'Intermediate Treasury'],
    ['TLT', 'Long Treasury'], ['TIP', 'Inflation-linked Treasury'],
  ].map(([symbol, label]) => etf(symbol, `${label} ETF`, 'Rates', ISHARES)),
  etf('LQD', 'Investment-grade credit ETF', 'Credit', ISHARES),
  etf('HYG', 'High-yield credit ETF', 'Credit', ISHARES),
  etf('EMB', 'Emerging-market USD debt ETF', 'Credit', ISHARES),
  etf('BKLN', 'Senior loans ETF', 'Credit', INVESCO),
  etf('DBC', 'Broad commodity futures ETF', 'Commodities', INVESCO),
  etf('GLD', 'Gold ETP', 'Commodities', 'https://www.ssga.com/us/en/individual/capabilities/alternatives/gold'),
  etf('SLV', 'Silver ETP', 'Commodities', ISHARES),
  etf('USO', 'Oil futures ETF', 'Commodities', 'https://www.uscfinvestments.com/uso'),
  etf('UNG', 'Natural gas futures ETF', 'Commodities', 'https://www.uscfinvestments.com/ung'),
  etf('CPER', 'Copper futures ETF', 'Commodities', 'https://www.uscfinvestments.com/cper'),
  etf('DBA', 'Agriculture futures ETF', 'Commodities', INVESCO),
  etf('UUP', 'USD strength ETF', 'FX', INVESCO),
  etf('FXE', 'EUR strength versus USD ETP', 'FX', INVESCO),
  etf('FXY', 'JPY strength versus USD ETP', 'FX', INVESCO),
  etf('VIXY', 'Short-term VIX futures ETF', 'Volatility', 'https://www.proshares.com/our-etfs/strategic/vixy'),
]);
const MACRO_REFERENCES = Object.freeze([
  ...[['DGS2', '2-year Treasury yield'], ['DGS10', '10-year Treasury yield'], ['DGS30', '30-year Treasury yield']]
    .map(([id, label]) => Object.freeze({ id, symbol: id, label, group: 'Rates', provider: 'fred', transform: 'yield_change_bp', units: 'percent', issuerUrl: `https://fred.stlouisfed.org/series/${id}` })),
  ...[['BAMLH0A0HYM2', 'High-yield credit spread'], ['BAMLC0A0CM', 'Investment-grade credit spread']]
    .map(([id, label]) => Object.freeze({ id, symbol: id, label, group: 'Credit', provider: 'fred', transform: 'spread_change_bp', units: 'percent', issuerUrl: `https://fred.stlouisfed.org/series/${id}` })),
  Object.freeze({ id: 'EURUSD', symbol: 'EURUSD=X', label: 'EUR strength versus USD', group: 'FX', provider: 'yahoo', transform: 'fx_return', currency: 'USD', units: 'USD per EUR' }),
  Object.freeze({ id: 'JPYUSD', symbol: 'JPY=X', label: 'JPY strength versus USD', group: 'FX', provider: 'yahoo', transform: 'fx_inverse_return', currency: 'JPY', units: 'JPY per USD' }),
  Object.freeze({ id: 'GBPUSD', symbol: 'GBPUSD=X', label: 'GBP strength versus USD', group: 'FX', provider: 'yahoo', transform: 'fx_return', currency: 'USD', units: 'USD per GBP' }),
  Object.freeze({ id: 'VIX', symbol: 'VIX', label: 'Spot equity implied volatility', group: 'Volatility', provider: 'cboe', transform: 'volatility_change', units: 'index points', issuerUrl: 'https://www.cboe.com/tradable_products/vix/vix_historical_data' }),
]);
const PCA_REFERENCES = Object.freeze([...ETF_REFERENCES, ...MACRO_REFERENCES]);

module.exports = { CATALOG_VERSION, ETF_REFERENCES, MACRO_REFERENCES, PCA_REFERENCES };
