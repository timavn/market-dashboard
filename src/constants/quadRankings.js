// Quad Regime Rankings
// Based on HEDGEYE "Highest/Lowest Expected Values By Quad Regime" framework
// Rankings represent position in "Best" list for each Quad (1 = strongest, higher = weaker)

export const QUAD_RANKINGS = {
  // Asset Classes rankings by Quad
  assetClasses: {
    quad1: {
      'Equities': 1,
      'Credit': 2,
      'Commodities': 3,
      'FX': 4
    },
    quad2: {
      'Commodities': 1,
      'Equities': 2,
      'Credit': 3,
      'FX': 4
    },
    quad3: {
      'Gold': 1,
      'Commodities': 2,
      'Fixed Income': 3
    },
    quad4: {
      'Fixed Income': 1,
      'Gold': 2,
      'USD': 3
    }
  },

  // Equity Sectors rankings by Quad
  equitySectors: {
    quad1: {
      'Tech': 1,
      'Consumer Discretionary': 2,
      'Communication Services': 3,
      'Industrials': 4,
      'Materials': 5,
      'REITs': 6
    },
    quad2: {
      'Tech': 1,
      'Industrials': 2,
      'Financials': 3,
      'Energy': 4,
      'Consumer Discretionary': 5
    },
    quad3: {
      'Utilities': 1,
      'Energy': 2,
      'REITs': 3,
      'Tech': 4,
      'Consumer Staples': 5,
      'Health Care': 6
    },
    quad4: {
      'Consumer Staples': 1,
      'Health Care': 2,
      'Utilities': 3
    }
  },

  // Equity Style Factors rankings by Quad
  equityStyleFactors: {
    quad1: {
      'High Beta': 1,
      'Momentum': 2,
      'Leverage': 3,
      'Secular Growth': 4,
      'Mid Caps': 5
    },
    quad2: {
      'Secular Growth': 1,
      'High Beta': 2,
      'Small Caps': 3,
      'Cyclical Growth': 4,
      'Momentum': 5
    },
    quad3: {
      'Secular Growth': 1,
      'Momentum': 2,
      'Mid Caps': 3,
      'Low Beta': 4,
      'Quality': 5
    },
    quad4: {
      'Low Beta': 1,
      'Dividend Yield': 2,
      'Quality': 3,
      'Defensives': 4,
      'Value': 5
    }
  },

  // Fixed Income Sectors rankings by Quad
  fixedIncomeSectors: {
    quad1: {
      'BDCs': 1,
      'Convertibles': 2,
      'HY Credit': 3,
      'EM $ Debt': 4,
      'Leveraged Loans': 5
    },
    quad2: {
      'Convertibles': 1,
      'BDCs': 2,
      'Preferreds': 3,
      'Leveraged Loans': 4,
      'HY Credit': 5
    },
    quad3: {
      'Munis': 1,
      'EM $ Debt': 2,
      'Long Bond': 3,
      'TIPS': 4,
      'Treasury Belly': 5
    },
    quad4: {
      'Long Bond': 1,
      'Treasury Belly': 2,
      'IG Credit': 3,
      'Munis': 4,
      'MBS': 5
    }
  }
};

// Helper to get all rankings for a category across all quads
export const getRankingsForCategory = (categoryType, categoryName) => {
  const rankings = QUAD_RANKINGS[categoryType];
  if (!rankings) return null;

  return {
    quad1: rankings.quad1[categoryName] || null,
    quad2: rankings.quad2[categoryName] || null,
    quad3: rankings.quad3[categoryName] || null,
    quad4: rankings.quad4[categoryName] || null
  };
};



