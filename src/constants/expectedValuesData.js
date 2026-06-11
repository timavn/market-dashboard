const quadData = [
  {
    quad: 'Quad 1: Goldilocks',
    bestAssetClasses: 'Equities, Credit, Commodities, FX',
    worstAssetClasses: 'Fixed Income, USD',
    bestEquitySectors: 'Tech, Consumer Discretionary, Communication Services, Industrials, Materials, REITS',
    worstEquitySectors: 'Utilities, Consumer Staples, Health Care',
    bestEquityStyleFactors: 'High Beta, Momentum, Leverage, Secular Growth, Mid Caps',
    worstEquityStyleFactors: 'Low Beta, Defensives, Value, Dividend Yield, Small Caps',
    bestFixedIncomeSectors: 'BDCs, Convertibles, HY Credit, EM $ Debt, Leveraged Loans',
    worstFixedIncomeSectors: 'TIPS, Short Duration Treasurys, MBS, Treasury Belly, Long Bond',
  },
  {
    quad: 'Quad 2: Reflation',
    bestAssetClasses: 'Commodities, Equities, Credit, FX',
    worstAssetClasses: 'Fixed Income, USD',
    bestEquitySectors: 'Tech, Industrials, Financials, Energy, Consumer Discretionary',
    worstEquitySectors: 'Utilities, Communication Services, Consumer Staples, REITS, Health Care',
    bestEquityStyleFactors: 'Secular Growth, High Beta, Small Caps, Cyclical Growth, Momentum',
    worstEquityStyleFactors: 'Low Beta, Dividend Yield, Value, Defensives, Size',
    bestFixedIncomeSectors: 'Convertibles, BDCs, Preferreds, Leveraged Loans, HY Credit',
    worstFixedIncomeSectors: 'Long Bond, Treasury Belly, Munis, MBS, IG Credit',
  },
  {
    quad: 'Quad 3: Stagflation',
    bestAssetClasses: 'Gold, Commodities, Fixed Income',
    worstAssetClasses: 'Credit',
    bestEquitySectors: 'Utilities, Energy, REITS, Tech, Consumer Staples, Health Care',
    worstEquitySectors: 'Communication Services, Financials, Consumer Discretionary, Industrials, Materials',
    bestEquityStyleFactors: 'Secular Growth, Momentum, Mid Caps, Low Beta, Quality',
    worstEquityStyleFactors: 'Small Caps, Dividend Yield, Value, Defensives, Size',
    bestFixedIncomeSectors: 'Munis, EM $ Debt, Long Bond, TIPS, Treasury Belly',
    worstFixedIncomeSectors: 'BDCs, Preferreds, Convertibles, Leveraged Loans, HY Credit',
  },
  {
    quad: 'Quad 4: Deflation',
    bestAssetClasses: 'Fixed Income, Gold, USD',
    worstAssetClasses: 'Commodities, Equities, Credit, FX',
    bestEquitySectors: 'Consumer Staples, Health Care, Utilities',
    worstEquitySectors: 'Energy, Tech, Financials, Industrials, Consumer Discretionary',
    bestEquityStyleFactors: 'Low Beta, Dividend Yield, Quality, Defensives, Value',
    worstEquityStyleFactors: 'High Beta, Momentum, Leverage, Secular Growth, Cyclical Growth',
    bestFixedIncomeSectors: 'Long Bond, Treasury Belly, IG Credit, Munis, MBS',
    worstFixedIncomeSectors: 'Preferreds, EM Local Currency, BDCs, Leveraged Loans, TIPS',
  },
];

const quarterlyExpectedValues = [
  { name: 'S&P 500 INDEX', ticker: 'SPY', q1: 0.0, q2: 4.6, q3: -3.1, q4: -0.8 },
  { name: 'Communication Services', ticker: 'XLC', q1: 7.3, q2: 1.4, q3: -1.0, q4: -0.3 },
  { name: 'Consumer Cyclical', ticker: 'XLY', q1: 8.1, q2: 4.4, q3: 0.0, q4: -0.8 },
  { name: 'Consumer Non-Cyclical', ticker: 'XLP', q1: 4.4, q2: 2.1, q3: 0.1, q4: 1.5 },
  { name: 'Energy', ticker: 'XLE', q1: 4.6, q2: 4.8, q3: 2.8, q4: -1.8 },
  { name: 'Financials', ticker: 'XLF', q1: 5.5, q2: 4.8, q3: -0.8, q4: -0.3 },
  { name: 'Health Care', ticker: 'XLV', q1: 4.5, q2: 3.9, q3: -0.3, q4: 1.8 },
  { name: 'Industrials', ticker: 'XLI', q1: 6.3, q2: 5.1, q3: -0.4, q4: -0.1 },
  { name: 'Information Technology', ticker: 'XLK', q1: 9.4, q2: 7.7, q3: 0.7, q4: -2.1 },
  { name: 'Materials', ticker: 'XLB', q1: 5.9, q2: 4.1, q3: -0.7, q4: 0.6 },
  { name: 'REITS', ticker: 'XLRE', q1: 5.0, q2: 2.9, q3: 0.5, q4: 1.0 },
  { name: 'Utilities', ticker: 'XLU', q1: 3.5, q2: 0.8, q3: 2.7, q4: 1.4 },
  { name: 'Growth', ticker: 'IWF', q1: 7.7, q2: 5.8, q3: -3.1, q4: -1.5 },
  { name: 'Value', ticker: 'IWD', q1: 5.5, q2: 3.4, q3: 0.0, q4: 0.1 },
  { name: 'Cyclicals', ticker: 'RSP', q1: 7.8, q2: 5.5, q3: 0.0, q4: -2.1 },
  { name: 'Defensives', ticker: 'DEF', q1: 5.6, q2: 3.9, q3: -0.1, q4: 0.3 },
  { name: 'High Beta', ticker: 'SPHB', q1: 8.9, q2: 8.2, q3: -1.0, q4: -3.3 },
  { name: 'Low Beta', ticker: 'SPLV', q1: 3.9, q2: 2.3, q3: 0.8, q4: 2.4 },
  { name: 'Momentum', ticker: 'MTUM', q1: 7.2, q2: 5.1, q3: 0.9, q4: -1.5 },
  { name: 'Quality', ticker: 'QUAL', q1: 6.8, q2: 4.7, q3: 0.1, q4: 0.8 },
  { name: 'Dividend Yield', ticker: 'SDY', q1: 5.5, q2: 3.2, q3: -0.2, q4: 2.2 },
  { name: 'Size', ticker: 'OEF', q1: 4.8, q2: 3.2, q3: -0.1, q4: -1.1 },
  { name: 'Secular Growth', ticker: 'QQQ', q1: 8.1, q2: 7.7, q3: 0.6, q4: -2.3 },
  { name: 'Mid-Caps', ticker: 'MDY', q1: 6.6, q2: 5.1, q3: 0.6, q4: -0.8 },
  { name: 'Small-Caps', ticker: 'IWM', q1: 6.2, q2: 5.7, q3: -0.5, q4: -1.2 },
  { name: 'BARCLAYS AGG', ticker: 'AGG', q1: 1.3, q2: 0.6, q3: 0.4, q4: 2.0 },
  { name: 'Leveraged Loans', ticker: 'BKLN', q1: 2.2, q2: 1.3, q3: 0.4, q4: 0.8 },
  { name: 'BDCs', ticker: 'BIZD', q1: 5.9, q2: 5.8, q3: -1.1, q4: -0.1 },
  { name: 'Preferreds', ticker: 'PFF', q1: 2.1, q2: 2.9, q3: -0.3, q4: -0.2 },
  { name: 'IG Credit', ticker: 'LQD', q1: 2.0, q2: 0.8, q3: 0.2, q4: 2.2 },
  { name: 'HY Credit', ticker: 'HYG', q1: 3.3, q2: 2.1, q3: 0.0, q4: 1.4 },
  { name: 'Convertibles', ticker: 'CWB', q1: 5.1, q2: 5.8, q3: -0.7, q4: 0.3 },
  { name: 'EM USD Debt', ticker: 'EMB', q1: 2.8, q2: 1.8, q3: 0.7, q4: 2.0 },
  { name: 'EM Local Currency Debt', ticker: 'EMLC', q1: 1.7, q2: 2.1, q3: -0.5, q4: 0.2 },
  { name: '1-3yr Treasurys', ticker: 'SHY', q1: 0.7, q2: 0.4, q3: 0.5, q4: 1.2 },
  { name: '3-10yr Treasurys', ticker: 'IEF', q1: 1.2, q2: 0.2, q3: 0.6, q4: 2.4 },
  { name: '10-20yr Treasurys', ticker: 'TLT', q1: 1.4, q2: -0.2, q3: 0.4, q4: 3.3 },
  { name: '20+ Year Treasurys', ticker: 'EDV', q1: 1.5, q2: -0.7, q3: 0.5, q4: 4.1 },
  { name: '0-5yr TIPS', ticker: 'STIP', q1: 0.7, q2: 1.0, q3: 0.8, q4: 0.6 },
  { name: '5-10yr TIPS', ticker: 'TIP', q1: 1.0, q2: 1.5, q3: 0.9, q4: 1.4 },
  { name: 'MBS', ticker: 'MBB', q1: 1.0, q2: 0.6, q3: 0.6, q4: 1.6 },
  { name: 'Munis', ticker: 'MUB', q1: 1.5, q2: 0.4, q3: 0.4, q4: 1.7 },
  { name: 'Taxable Munis', ticker: 'BAB', q1: 2.1, q2: 0.5, q3: 0.7, q4: 1.7 },
  { name: 'CRB Index', ticker: 'DBC', q1: 1.3, q2: 5.2, q3: 2.8, q4: -3.6 },
  { name: 'CRB Raw Index', ticker: '', q1: 0.3, q2: 0.9, q3: 3.7, q4: 0.0 },
  { name: 'CRB Foodstuffs Index', ticker: 'DBA', q1: -0.1, q2: 3.1, q3: 2.2, q4: -1.2 },
  { name: 'Bloomberg Energy Index', ticker: 'BNO', q1: 5.9, q2: 11.1, q3: 6.5, q4: -9.1 },
  { name: 'Bloomberg Precious Metals Index', ticker: 'DBP', q1: 3.0, q2: 3.2, q3: 0.3, q4: 2.3 },
  { name: 'Silver', ticker: 'SLV', q1: 5.0, q2: 3.9, q3: -1.3, q4: 2.8 },
  { name: 'Bitcoin', ticker: 'GBTC', q1: 80.8, q2: 33.2, q3: 157.2, q4: 7.8 },
  { name: 'WTI Crude Oil', ticker: 'USO', q1: 4.8, q2: 9.6, q3: 4.7, q4: -6.8 },
  { name: 'Natural Gas', ticker: 'UNG', q1: 2.0, q2: 3.8, q3: 3.5, q4: -3.7 },
  { name: 'Iron Ore', ticker: '', q1: -2.7, q2: 11.2, q3: -4.6, q4: -4.4 },
  { name: 'Copper', ticker: 'CPER', q1: 4.9, q2: 6.2, q3: -0.4, q4: 0.4 },
  { name: 'US Dollar Index', ticker: 'UUP', q1: -0.6, q2: -0.3, q3: 0.3, q4: 0.9 },
  { name: 'Gold', ticker: 'GLD', q1: 2.7, q2: 3.2, q3: 1.6, q4: 3.1 },
  { name: 'EM FX', ticker: 'CEW', q1: 0.2, q2: 0.6, q3: -1.2, q4: -1.9 },
];

const expectedValueByTicker = quarterlyExpectedValues.reduce((acc, item) => {
  if (item.ticker) acc[item.ticker.toUpperCase()] = item;
  return acc;
}, {});

const getExpectedValueForTicker = (ticker) => {
  if (!ticker) return null;
  return expectedValueByTicker[String(ticker).toUpperCase()] || null;
};

const getExpectedValueQuadScores = (item) => {
  if (!item) return null;
  return {
    q1: Number(item.q1),
    q2: Number(item.q2),
    q3: Number(item.q3),
    q4: Number(item.q4),
  };
};

const getBestQuadForExpectedValue = (item) => {
  const scores = getExpectedValueQuadScores(item);
  if (!scores) return null;
  return Object.entries(scores)
    .sort((a, b) => b[1] - a[1])
    .map(([quad]) => quad.toUpperCase())[0] || null;
};

const expectedValuesData = {
  quadData,
  quarterlyExpectedValues,
  expectedValueByTicker,
  getExpectedValueForTicker,
  getExpectedValueQuadScores,
  getBestQuadForExpectedValue,
};

module.exports = expectedValuesData;
