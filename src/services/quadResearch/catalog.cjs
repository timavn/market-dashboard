// Independent, investable proxy definitions. These do not redefine Hedgeye's
// published factors, or turn an ETF proxy into the publisher's original series.
const { quadData } = require('../../constants/expectedValuesData.js');

const PREFIXES = Object.freeze({
  assetClasses: 'asset-class', equitySectors: 'equity-sector',
  equityStyleFactors: 'equity-style-factor', fixedIncomeSectors: 'fixed-income-sector',
});
function exposureId(groupId, label) {
  const slug = label.trim().toLowerCase().replace(/\$/g, ' usd ').replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${PREFIXES[groupId]}-${slug}`;
}
const issuer = {
  ishares: (id, name) => `https://www.ishares.com/us/products/${id}/${name}`,
  spdr: (name, ticker) => `https://www.ssga.com/us/en/intermediary/etfs/${name}-${ticker.toLowerCase()}`,
  invesco: (name) => `https://www.invesco.com/us/en/financial-products/etfs/${name}.html`,
};
const BENCHMARK_CHANGES = Object.freeze({
  QUAL: Object.freeze([{ date: '2015-09-01', reason: 'Changed from MSCI USA Quality to MSCI USA Sector Neutral Quality. Earlier ETF returns retain the strategy then in effect.',
    sourceUrl: 'https://www.sec.gov/Archives/edgar/data/1100663/000119312515403930/R225.htm' }]),
  MTUM: Object.freeze([{ date: '2020-11-23', reason: 'Changed from MSCI USA Momentum to its SR Variant. History measures the ETF as managed across this change.',
    sourceUrl: 'https://www.ishares.com/us/literature/summary-prospectus/sp-ishares-edge-msci-usa-momentum-factor-etf-7-31.pdf' }]),
  PFF: Object.freeze([{ date: '2019-02-01', endDate: '2019-10-31', reason: 'Transitioned from S&P U.S. Preferred Stock to ICE Exchange-Listed Preferred & Hybrid Securities through an interim index; final benchmark effective November 1, 2019.',
    sourceUrl: 'https://www.sec.gov/Archives/edgar/data/1100663/000168386320009930/f5753d1.htm' }]),
});
function benchmark(groupId, label, symbol, inception, definition, sourceUrl) {
  return Object.freeze({ exposureId: exposureId(groupId, label), groupId, label, symbol,
    inception, currency: 'USD', definition, sourceUrl, methodologyChanges: BENCHMARK_CHANGES[symbol] || Object.freeze([]),
    returnDefinition: 'Yahoo split/distribution-adjusted USD market-price return of the ETF as managed over time; expenses are embedded. This is not a constant-methodology index backtest.' });
}
function group(id, label, startQuarter, definitions, methodologyChanges = []) {
  return Object.freeze({ id, label, startQuarter, methodologyChanges: Object.freeze(methodologyChanges),
    benchmarks: Object.freeze(definitions.map(args => benchmark(id, ...args))) });
}

const GROUPS = Object.freeze([
  group('assetClasses', 'Asset classes', '2007-Q2', [
    ['Equities', 'SPY', '1993-01-22', 'S&P 500 large-cap U.S. equities.', issuer.spdr('spdr-sp-500-etf-trust', 'SPY')],
    ['Commodities', 'DBC', '2006-02-03', 'Diversified commodity futures fund, including collateral income and roll effects; not a spot commodity index.', issuer.invesco('invesco-db-commodity-index-tracking-fund')],
    ['Fixed Income', 'AGG', '2003-09-22', 'Broad U.S. investment-grade aggregate bonds, including government, corporate and securitized debt.', issuer.ishares('239458', 'ishares-core-total-us-bond-market-etf')],
    ['Gold', 'GLD', '2004-11-18', 'Physically backed gold trust after trust expenses.', issuer.spdr('spdr-gold-shares', 'GLD')],
    ['USD', 'UUP', '2007-02-20', 'Long U.S. dollar futures versus a specified developed-currency basket, including collateral and roll effects; not cash dollars.', issuer.invesco('invesco-db-us-dollar-index-bullish-fund')],
  ]),
  group('equitySectors', 'Equity sectors', '2018-Q4', [
    ['Communication Services', 'XLC', '2018-06-18', 'S&P 500 communication-services sector under the post-September-2018 structure.', issuer.spdr('state-street-communication-services-select-sector-spdr-etf', 'XLC')],
    ['Consumer Discretionary', 'XLY', '1998-12-16', 'S&P 500 consumer-discretionary sector.', issuer.spdr('state-street-consumer-discretionary-select-sector-spdr-etf', 'XLY')],
    ['Consumer Staples', 'XLP', '1998-12-16', 'S&P 500 consumer-staples sector.', issuer.spdr('state-street-consumer-staples-select-sector-spdr-etf', 'XLP')],
    ['Energy', 'XLE', '1998-12-16', 'S&P 500 energy equities; not energy commodity futures.', issuer.spdr('state-street-energy-select-sector-spdr-etf', 'XLE')],
    ['Financials', 'XLF', '1998-12-16', 'S&P 500 financials sector.', issuer.spdr('state-street-financial-select-sector-spdr-etf', 'XLF')],
    ['Health Care', 'XLV', '1998-12-16', 'S&P 500 health-care sector.', issuer.spdr('state-street-health-care-select-sector-spdr-etf', 'XLV')],
    ['Industrials', 'XLI', '1998-12-16', 'S&P 500 industrials sector.', issuer.spdr('state-street-industrial-select-sector-spdr-etf', 'XLI')],
    ['Tech', 'XLK', '1998-12-16', 'S&P 500 information-technology sector.', issuer.spdr('state-street-technology-select-sector-spdr-etf', 'XLK')],
    ['Materials', 'XLB', '1998-12-16', 'S&P 500 materials equities.', issuer.spdr('state-street-materials-select-sector-spdr-etf', 'XLB')],
    ['REITS', 'XLRE', '2015-10-07', 'S&P 500 real-estate sector; large-cap equity REIT and real-estate-management proxy.', issuer.spdr('state-street-real-estate-select-sector-spdr-etf', 'XLRE')],
    ['Utilities', 'XLU', '1998-12-16', 'S&P 500 utilities sector.', issuer.spdr('state-street-utilities-select-sector-spdr-etf', 'XLU')],
  ], [{ date: '2018-09-24', reason: 'Communication-services restructuring changed sector membership. Begin with the first complete subsequent quarter.',
    sourceUrl: 'https://www.indexologyblog.com/2018/12/04/lets-talk-about-communication/' }]),
  group('equityStyleFactors', 'Equity styles', '2013-Q4', [
    ['High Beta', 'SPHB', '2011-05-05', 'S&P 500 High Beta Index equity portfolio; not a leveraged ETF.', issuer.invesco('invesco-sp-500-high-beta-etf')],
    ['Momentum', 'MTUM', '2013-04-16', 'U.S. large- and mid-cap equities selected for relative price momentum.', issuer.ishares('251614', 'ishares-msci-usa-momentum-factor-etf')],
    ['Mid Caps', 'MDY', '1995-05-04', 'S&P MidCap 400 U.S. equities.', issuer.spdr('spdr-sp-midcap-400-etf-trust', 'MDY')],
    ['Value', 'IWD', '2000-05-22', 'Russell 1000 Value large- and mid-cap U.S. equities.', issuer.ishares('239708', 'ishares-russell-1000-value-etf')],
    ['Dividend Yield', 'VYM', '2006-11-10', 'FTSE High Dividend Yield Index; U.S. stocks selected for above-average forecast dividend yields, excluding REITs.', 'https://investor.vanguard.com/investment-products/etfs/profile/vym'],
    ['Small Caps', 'IWM', '2000-05-22', 'Russell 2000 U.S. small-cap equities.', issuer.ishares('239710', 'ishares-russell-2000-etf')],
    ['Quality', 'QUAL', '2013-07-16', 'U.S. sector-neutral quality equities selected using profitability, earnings stability and leverage measures.', issuer.ishares('256101', 'ishares-msci-usa-quality-factor-etf')],
  ]),
  group('fixedIncomeSectors', 'Fixed-income sectors', '2013-Q2', [
    ['BDCs', 'BIZD', '2013-02-11', 'U.S. publicly traded business-development-company equities; retained in the publisher’s category, although not bonds.', 'https://www.vaneck.com/us/en/investments/bdc-income-etf-bizd/'],
    ['Convertibles', 'CWB', '2009-04-14', 'U.S. convertible securities.', issuer.spdr('spdr-bloomberg-convertible-securities-etf', 'CWB')],
    ['HY Credit', 'HYG', '2007-04-04', 'Liquid U.S. dollar high-yield corporate bonds.', issuer.ishares('239565', 'ishares-iboxx-high-yield-corporate-bond-etf')],
    ['EM $ Debt', 'EMB', '2007-12-17', 'U.S. dollar-denominated emerging-market sovereign and quasi-sovereign debt.', issuer.ishares('239572', 'ishares-jp-morgan-usd-emerging-markets-bond-etf')],
    ['Leveraged Loans', 'BKLN', '2011-03-03', 'Large liquid institutional leveraged loans; floating-rate credit exposure.', issuer.invesco('invesco-senior-loan-etf')],
    ['TIPS', 'TIP', '2003-12-04', 'Broad U.S. Treasury inflation-protected bonds; not restricted to 5–10-year maturities.', issuer.ishares('239467', 'ishares-tips-bond-etf')],
    ['Short Duration Treasurys', 'SHY', '2002-07-22', 'U.S. Treasuries with remaining maturities between one and three years.', issuer.ishares('239452', 'ishares-13-year-treasury-bond-etf')],
    ['MBS', 'MBB', '2007-03-13', 'U.S. agency mortgage-backed securities.', issuer.ishares('239465', 'ishares-mbs-etf')],
    ['Treasury Belly', 'IEF', '2002-07-22', 'Explicit intermediate-duration proxy: U.S. Treasuries with 7–10 years remaining maturity.', issuer.ishares('239456', 'ishares-710-year-treasury-bond-etf')],
    ['Long Bond', 'TLT', '2002-07-22', 'U.S. coupon Treasuries with more than 20 years remaining maturity; not STRIPS.', issuer.ishares('239454', 'ishares-20-year-treasury-bond-etf')],
    ['Preferreds', 'PFF', '2007-03-26', 'U.S. preferred and hybrid income securities.', issuer.ishares('239826', 'ishares-us-preferred-stock-etf')],
    ['EM Local Currency', 'EMLC', '2010-07-22', 'Emerging-market local-currency sovereign bonds translated to USD, including currency returns.', 'https://www.vaneck.com/us/en/investments/jp-morgan-em-local-currency-bond-etf-emlc/'],
    ['IG Credit', 'LQD', '2002-07-22', 'Liquid U.S. dollar investment-grade corporate bonds.', issuer.ishares('239566', 'ishares-iboxx-investment-grade-corporate-bond-etf')],
    ['Munis', 'MUB', '2007-09-07', 'Broad investment-grade U.S. tax-exempt municipal bonds; pretax investor returns, without invented tax-equivalent adjustments.', issuer.ishares('239766', 'ishares-national-amtfree-muni-bond-etf')],
  ]),
]);

const EXCLUSIONS = Object.freeze(Object.fromEntries([
  ['assetClasses', 'Credit', 'No verified definition for broad Credit. High-yield credit or arbitrary credit blends would change the factor.'],
  ['assetClasses', 'FX', 'Currency basket, weights and quote direction are undefined. EM FX is not broad FX.'],
  ['equityStyleFactors', 'Cyclical Growth', 'No verified cyclical-growth benchmark or point-in-time constituent definition.'],
  ['equityStyleFactors', 'Leverage', 'Balance-sheet leverage requires a defined equity characteristic and point-in-time fundamentals; leveraged ETFs are different.'],
  ['equityStyleFactors', 'Size', 'The factor direction and benchmark are undefined; mega-caps and small-minus-large are not interchangeable.'],
  ['equityStyleFactors', 'Defensives', 'A generic defensive-equity factor is not established by the legacy DEF ticker.'],
  ['equityStyleFactors', 'Secular Growth', 'Nasdaq-100 membership does not establish a pure secular-growth factor.'],
  ['equityStyleFactors', 'Low Beta', 'Low volatility is not low beta; SPLV is not an established equivalent.'],
].map(([id, label, reason]) => [exposureId(id, label), reason])));

const FIELD_NAMES = Object.freeze({ assetClasses: 'AssetClasses', equitySectors: 'EquitySectors',
  equityStyleFactors: 'EquityStyleFactors', fixedIncomeSectors: 'FixedIncomeSectors' });
const universe = new Map();
quadData.forEach(quad => Object.entries(FIELD_NAMES).forEach(([groupId, field]) => {
  ['best', 'worst'].forEach(side => String(quad[`${side}${field}`] || '').split(',').map(x => x.trim()).filter(Boolean)
    .forEach(label => universe.set(exposureId(groupId, label), { exposureId: exposureId(groupId, label), groupId, label })));
}));
const GAPS = Object.freeze([...universe.values()].flatMap(factor => quadData.flatMap((quad, index) => {
  const field = FIELD_NAMES[factor.groupId];
  const labels = ['best', 'worst'].flatMap(side => String(quad[`${side}${field}`] || '').split(',').map(x => x.trim()));
  return labels.includes(factor.label) ? [] : [Object.freeze({ ...factor, quad: index + 1, quadKey: `q${index + 1}` })];
})));

module.exports = { GROUPS, EXCLUSIONS, GAPS, exposureId };
