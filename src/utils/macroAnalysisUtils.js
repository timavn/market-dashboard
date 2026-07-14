
/**
 * Macro Analysis Utilities
 * 
 * Maps portfolio holdings to 5 key macro factors:
 * 1. Growth
 * 2. Defensive / Income
 * 3. Inflation
 * 4. Volatility / Liquidity
 * 5. Real Rates / Duration
 */

// Factor Definitions with descriptions and colors
export const MACRO_FACTORS = {
    GROWTH: {
        id: 'growth',
        label: 'Growth',
        description: 'Exposure to economic expansion (Equities, High Yield, Crypto)',
        calculationMethod: 'Beta to SPY, QQQ, & Cyclical Sectors',
        color: '#10B981', // Emerald
        angle: 90
    },
    DEFENSIVE: {
        id: 'defensive',
        label: 'Defensive',
        description: 'Protection against downturns (Utilities, Staples, Treasuries)',
        calculationMethod: 'Exposure to Low Volatility & Quality Factors',
        color: '#6366F1', // Indigo
        angle: 162
    },
    INFLATION: {
        id: 'inflation',
        label: 'Inflation',
        description: 'Hedges against rising prices (Energy, Materials, TIPS, Gold)',
        calculationMethod: 'Correlation to CPI, Commodities, & Breakevens',
        color: '#F97316', // Orange
        angle: 234
    },
    VOLATILITY: {
        id: 'volatility',
        label: 'Volatility',
        description: 'Protection against market shocks (VIX, Tail Hedges, Cash)',
        calculationMethod: 'Sensitivity to VIX & Implied Volatility',
        color: '#F59E0B', // Amber
        angle: 306
    },
    REAL_RATES: {
        id: 'real_rates',
        label: 'Real Rates',
        description: 'Sensitivity to interest rates (Long Duration = Positive, Growth = Negative)',
        calculationMethod: 'Duration & Sensitivity to Real Yields (TIP)',
        color: '#06B6D4', // Cyan
        angle: 18
    }
};

/**
 * Heuristic mapping of Asset Classes / Tickers to Factor Betas
 * Ideally this comes from a database, but we estimate for now.
 * Betas are roughly -1.0 to 1.0
 */
const getFactorLoadings = (holding) => {
    const symbol = holding.symbol?.toUpperCase() || '';
    const assetClass = holding.assetClass || holding.assetType || '';
    const sector = holding.sector || '';
    const name = holding.description || holding.name || '';

    // Default Loadings
    let loadings = {
        growth: 0,
        defensive: 0,
        inflation: 0,
        volatility: 0,
        real_rates: 0
    };

    // --- 1. SPECIFIC TICKER OVERRIDES ---
    if (['SPY', 'VOO', 'IVV'].includes(symbol)) {
        return { growth: 0.9, defensive: 0.1, inflation: 0.1, volatility: -0.4, real_rates: -0.2 };
    }
    if (['QQQ', 'XLK', 'NVDA', 'MSFT', 'AAPL'].includes(symbol)) {
        return { growth: 1.2, defensive: -0.2, inflation: 0.0, volatility: -0.3, real_rates: -0.6 }; // High duration sensitivity
    }
    if (['IWM', 'VB'].includes(symbol)) {
        return { growth: 1.3, defensive: -0.3, inflation: 0.2, volatility: -0.2, real_rates: -0.1 };
    }
    if (['TLT', 'ZROZ'].includes(symbol)) { // Long Treasuries
        return { growth: -0.3, defensive: 0.8, inflation: -0.4, volatility: 0.2, real_rates: 1.0 };
    }
    if (['TBIL', 'BIL', 'SGOV', 'SHV', 'GBIL', 'CLIP', 'USFR', 'TFLO', 'XBIL'].includes(symbol)) { // Cash equivalents
        return { growth: 0, defensive: 0.2, inflation: -0.8, volatility: 0.8, real_rates: 0 }; // Cash is a vol buffer
    }
    if (['GLD', 'IAU', 'SLV'].includes(symbol)) {
        return { growth: 0.1, defensive: 0.4, inflation: 0.8, volatility: 0.3, real_rates: -0.6 }; // Gold hates real rates
    }
    if (['USO', 'XLE', 'XOP'].includes(symbol)) {
        return { growth: 0.4, defensive: 0.0, inflation: 1.0, volatility: 0.2, real_rates: 0.1 };
    }
    if (['BTC', 'ETH', 'IBIT'].includes(symbol) || name.includes('BITCOIN')) {
        return { growth: 1.5, defensive: -0.5, inflation: 0.4, volatility: -0.5, real_rates: -0.4 }; // Digital Gold / Tech
    }
    if (['VXX', 'UVXY'].includes(symbol)) {
        return { growth: -0.8, defensive: 0.2, inflation: 0.0, volatility: 1.5, real_rates: 0 };
    }

    // --- 2. ASSET CLASS / SECTOR RULES ---
    const lowerAssetClass = assetClass.toLowerCase();
    const lowerSector = sector.toLowerCase();
    const lowerName = name.toLowerCase();

    // EQUITIES
    if (lowerAssetClass.includes('equity') || lowerAssetClass.includes('stock')) {
        loadings.growth = 1.0;
        loadings.volatility = -0.4;
        loadings.real_rates = -0.2;

        // Sector nuances
        if (lowerSector.includes('technology') || lowerSector.includes('consumer discretionary')) {
            loadings.growth = 1.2;
            loadings.defensive = -0.2;
        }
        if (lowerSector.includes('utilities') || lowerSector.includes('staples') || lowerSector.includes('health')) {
            loadings.growth = 0.6;
            loadings.defensive = 0.8;
            loadings.volatility = -0.2; // Less volatile
        }
        if (lowerSector.includes('energy') || lowerSector.includes('materials')) {
            loadings.growth = 0.7;
            loadings.inflation = 0.9;
        }
        if (lowerSector.includes('financial')) {
            loadings.growth = 0.9;
            loadings.real_rates = 0.4; // Banks like rates (mostly)
        }
        if (lowerSector.includes('real estate') || lowerSector.includes('reit')) {
            loadings.growth = 0.6;
            loadings.inflation = 0.5;
            loadings.real_rates = -0.7; // Very rate sensitive
        }
    }

    // FIXED INCOME
    else if (lowerAssetClass.includes('fixed income') || lowerAssetClass.includes('bond') || lowerName.includes('treasury')) {
        loadings.defensive = 0.7;
        loadings.growth = -0.1;

        if (lowerName.includes('inflation') || lowerName.includes('tips')) {
            loadings.inflation = 1.0;
            loadings.real_rates = 0.0; // TIPS hedge real rates mostly
        } else if (lowerName.includes('high yield') || lowerName.includes('junk')) {
            loadings.growth = 0.6; // High correlation to equity
            loadings.defensive = 0.2;
            loadings.volatility = -0.3;
        } else {
            // Nominal Treasuries / IG
            loadings.real_rates = 0.8;
            loadings.inflation = -0.5;
        }
    }

    // CASH
    else if (lowerAssetClass.includes('cash') || lowerName.includes('money market')) {
        loadings.growth = 0;
        loadings.defensive = 0.1;
        loadings.volatility = 0.5; // Dry powder
        loadings.inflation = -1.0; // Cash rots in inflation
    }

    // COMMODITIES
    else if (lowerAssetClass.includes('commodity')) {
        loadings.inflation = 1.0;
        loadings.growth = 0.4;
        loadings.defensive = 0;
    }

    // CRYPTO
    else if (lowerAssetClass.includes('crypto')) {
        loadings.growth = 1.5;
        loadings.volatility = -0.8; // Adds vol
        loadings.inflation = 0.3;
    }

    return loadings;
};

/**
 * Calculates net exposure for the entire portfolio for all 5 factors.
 * Returns an array of objects for the Radar Chart and detailed analysis.
 */
export const calculateMacroFactorExposures = (holdings, totalPortfolioValue) => {
    // Initialize totals
    let factorTotals = {
        growth: 0,
        defensive: 0,
        inflation: 0,
        volatility: 0,
        real_rates: 0
    };

    // Track contributions for each factor: contributorMap[factorId] = [ { symbol, contribution, weight, beta } ]
    let contributorMap = {
        growth: [],
        defensive: [],
        inflation: [],
        volatility: [],
        real_rates: []
    };

    const safeTotalValue = totalPortfolioValue || 1;

    // Process each holding
    holdings.forEach(holding => {
        const marketValue = parseFloat(holding.marketValue) || 0;
        const weight = marketValue / safeTotalValue;
        const loadings = getFactorLoadings(holding);

        // Add weighted contribution and track details
        Object.keys(factorTotals).forEach(factorId => {
            const beta = loadings[factorId];
            const contribution = weight * beta;

            factorTotals[factorId] += contribution;

            // Track every holding for this factor (so "expand to view all" = full portfolio)
            contributorMap[factorId].push({
                symbol: holding.symbol,
                name: holding.name || holding.description,
                weight: weight,
                beta: beta,
                contribution: contribution
            });
        });
    });

    // Normalize/Scale results for the chart (0-100 scale ideally, but can be negative)
    // We multiply by 100 to get "Beta-adjusted Percent Exposure"
    const formattedData = Object.keys(MACRO_FACTORS).map(key => {
        const factorId = MACRO_FACTORS[key].id;
        const rawScore = factorTotals[factorId];
        // Score for radar chart
        const score = Math.round(rawScore * 100);

        // Get Top 5 Contributors for this factor
        // Sort by ABSOLUTE contribution (biggest drivers, whether + or -)
        // OR should we sort by signed contribution? Usually we want to know what is pushing it UP.
        // Let's sort by signed contribution descending (biggest positive drivers) 
        // AND maybe separate biggest detractors?
        // User asked for "Top 5 securities in each contributing to the weighting".
        // Let's maximize meaningfulness: Sort by absolute magnitude, but maybe prioritize positive if the net is positive?
        // Sort by absolute contribution magnitude; return all for expand-in-UI.
        const sorted = contributorMap[factorId]
            .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
        const allContributors = sorted.map(c => ({
            ...c,
            contributionPercent: (c.contribution * 100).toFixed(2),
            weightPercent: (c.weight * 100).toFixed(1)
        }));

        return {
            subject: MACRO_FACTORS[key].label,
            fullMark: 100, // For chart max
            score: score,
            factorId: factorId,
            color: MACRO_FACTORS[key].color,
            description: MACRO_FACTORS[key].description,
            calculationMethod: MACRO_FACTORS[key].calculationMethod,
            topContributors: allContributors.slice(0, 5), // legacy / summary
            allContributors
        };
    });

    return formattedData;
};
