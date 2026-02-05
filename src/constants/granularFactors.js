
export const GRANULAR_FACTORS = [
    // Factors to Own (Defensive/Inflation/Value)
    { category: 'Factors to Own', name: 'Gold', ticker: 'GLD', type: 'Commodity' },
    { category: 'Factors to Own', name: 'Inflation (TIPS)', ticker: 'TIP', type: 'Fixed Income' },
    { category: 'Factors to Own', name: 'Minerals (Mining)', ticker: 'XME', type: 'Equity' },
    { category: 'Factors to Own', name: 'Energy Producers', ticker: 'XOP', type: 'Equity' },
    { category: 'Factors to Own', name: 'Momentum', ticker: 'MTUM', type: 'Equity' },
    { category: 'Factors to Own', name: 'Low Volatility', ticker: 'SPLV', type: 'Equity' },

    // Factors to Avoid (High Growth/Risk/Beta)
    { category: 'Factors to Avoid', name: 'Unprofitable Tech (Proxy)', ticker: 'ARKK', type: 'Equity' },
    { category: 'Factors to Avoid', name: 'High Beta', ticker: 'SPHB', type: 'Equity' },
    { category: 'Factors to Avoid', name: 'Growth', ticker: 'SPYG', type: 'Equity' },
    { category: 'Factors to Avoid', name: 'SaaS / Cloud', ticker: 'IGV', type: 'Equity' },
    { category: 'Factors to Avoid', name: 'Semiconductors', ticker: 'SMH', type: 'Equity' },
    { category: 'Factors to Avoid', name: 'Broad Tech', ticker: 'XLK', type: 'Equity' }
];
