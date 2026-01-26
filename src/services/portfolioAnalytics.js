/**
 * Portfolio Analytics Service
 * Calculates advanced portfolio metrics, factor exposures, and risk analytics
 */

export class PortfolioAnalytics {

  /**
   * Calculate comprehensive portfolio metrics
   */
  static calculatePortfolioMetrics(holdings, snapshot) {
    const totalValue = snapshot.summary.totalValue;
    const totalCostBasis = snapshot.summary.totalCostBasis;

    return {
      // Basic metrics
      totalValue,
      totalCostBasis,
      totalGainLoss: snapshot.summary.totalGainLoss,
      totalGainLossPercent: snapshot.summary.totalGainLossPercent,
      positionCount: holdings.length,

      // Risk metrics
      ...this.calculateRiskMetrics(holdings, totalValue),

      // Exposure metrics
      ...this.calculateExposureMetrics(holdings, totalValue),

      // Concentration metrics
      ...this.calculateConcentrationMetrics(holdings, totalValue),

      // Factor exposures (Legacy)
      ...this.calculateFactorExposures(holdings, totalValue),

      // New Decision-Oriented Metrics
      longShortFactors: this.calculateLongShortFactors(holdings, totalValue),
      sensitivities: this.calculateSensitivityMetrics(holdings, totalValue),
      liquidity: this.calculateLiquidityMetrics(holdings, totalValue),
      scenarios: this.calculateScenarioAnalysis(holdings, totalValue)
    };
  }

  /**
   * Calculate risk metrics
   */
  static calculateRiskMetrics(holdings, totalValue) {
    // Calculate portfolio volatility (simplified)
    const returns = holdings.map(h => h.gainLossPercent || 0); // Using returns as simple proxy
    const avgReturn = returns.reduce((sum, r) => sum + r, 0) / (returns.length || 1);
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / (returns.length || 1);
    const volatility = Math.sqrt(variance);

    // Calculate Sharpe ratio (simplified - assumes 2% risk-free rate)
    const riskFreeRate = 2.0;
    const sharpeRatio = volatility > 0 ? (avgReturn - riskFreeRate) / volatility : 0;

    // Calculate VaR (simplified - 95% confidence)
    const sortedReturns = [...returns].sort((a, b) => a - b);
    const varIndex = Math.floor(sortedReturns.length * 0.05);
    const var95Percent = sortedReturns[Math.max(0, varIndex)] || 0;

    return {
      volatility: volatility.toFixed(2),
      sharpeRatio: sharpeRatio.toFixed(2),
      sortinoRatio: volatility > 0 ? (avgReturn / volatility).toFixed(2) : "0.00", // Simplified
      var95: (totalValue * Math.abs(var95Percent) / 100).toFixed(0),
      maxDrawdown: this.calculateMaxDrawdown(holdings)
    };
  }

  /**
   * Calculate exposure metrics
   */
  static calculateExposureMetrics(holdings, totalValue) {
    let grossExposure = 0;
    let netLongExposure = 0;
    let netShortExposure = 0;
    let longCount = 0;
    let shortCount = 0;

    holdings.forEach(holding => {
      const marketValue = holding.marketValue || 0;
      const weight = (marketValue / totalValue) * 100;

      // Determine if long or short based on market value or explicit type
      // Note: Data might represent shorts as negative market value or positive value with 'Short' type
      // Assuming negative market value implies short for this calculation

      const isShort = marketValue < 0 || holding.type === 'SHORT' || (holding.description && holding.description.includes('SHORT'));
      const absWeight = Math.abs(weight);

      grossExposure += absWeight;

      if (isShort) {
        netShortExposure += absWeight;
        shortCount++;
      } else {
        netLongExposure += absWeight;
        longCount++;
      }
    });

    const netExposure = netLongExposure - netShortExposure;

    return {
      grossExposure: grossExposure.toFixed(1),
      netLongExposure: netLongExposure.toFixed(1),
      netShortExposure: netShortExposure.toFixed(1),
      netExposure: netExposure.toFixed(1),
      longCount,
      shortCount
    };
  }

  /**
   * Calculate concentration metrics
   */
  static calculateConcentrationMetrics(holdings, totalValue) {
    // Sort holdings by absolute market value (risk sizing)
    const sortedHoldings = [...holdings].sort((a, b) => Math.abs(b.marketValue || 0) - Math.abs(a.marketValue || 0));

    if (totalValue === 0) return {
      top10HoldingsPercent: "0.0",
      largestPositionPercent: "0.0",
      hhiIndex: "0.000"
    };

    // Top 10 holdings percentage
    const top10Value = sortedHoldings.slice(0, 10).reduce((sum, h) => sum + Math.abs(h.marketValue || 0), 0);
    const top10Percent = (top10Value / totalValue) * 100;

    // Largest position percentage
    const largestPosition = sortedHoldings[0];
    const largestPositionPercent = largestPosition ? (Math.abs(largestPosition.marketValue) / totalValue) * 100 : 0;

    // HHI Index (Herfindahl-Hirschman Index)
    const hhi = holdings.reduce((sum, holding) => {
      const weight = (Math.abs(holding.marketValue || 0) / totalValue) * 100;
      return sum + Math.pow(weight, 2);
    }, 0);

    return {
      top10HoldingsPercent: top10Percent.toFixed(1),
      largestPositionPercent: largestPositionPercent.toFixed(1),
      hhiIndex: (hhi / 100).toFixed(3)
    };
  }

  /**
   * Calculate factor exposures
   */
  static calculateFactorExposures(holdings, totalValue) {
    // Legacy support for flat factor structure if needed, or implement similarly to LongShortFactors
    // For now, keeping the simplified original logic but ensuring safety
    if (totalValue === 0) return {};

    const factors = {
      largeCap: 0, midCap: 0, smallCap: 0,
      technology: 0, healthcare: 0, financials: 0, consumer: 0, energy: 0,
      northAmerica: 0, europe: 0, asiaPacific: 0, emergingMarkets: 0
    };

    holdings.forEach(holding => {
      const weight = (Math.abs(holding.marketValue || 0) / totalValue) * 100;
      const description = (holding.description || '').toUpperCase();
      const symbol = (holding.symbol || '').toUpperCase();

      // Simple heuristic mapping
      if (this.isTechnologySector(symbol, description)) factors.technology += weight;
      else if (this.isHealthcareSector(symbol, description)) factors.healthcare += weight;
      else if (this.isFinancialSector(symbol, description)) factors.financials += weight;
      else if (this.isEnergySector(symbol, description)) factors.energy += weight;
      else factors.consumer += weight;

      if (this.isInternational(symbol, description)) {
        factors.europe += weight * 0.4;
        factors.asiaPacific += weight * 0.4;
        factors.emergingMarkets += weight * 0.2;
      } else {
        factors.northAmerica += weight;
      }

      factors.largeCap += weight * 0.8;
      factors.midCap += weight * 0.15;
      factors.smallCap += weight * 0.05;
    });

    Object.keys(factors).forEach(key => factors[key] = factors[key].toFixed(1));
    return {
      marketCap: { largeCap: factors.largeCap, midCap: factors.midCap, smallCap: factors.smallCap },
      sectors: { technology: factors.technology, healthcare: factors.healthcare, financials: factors.financials, consumer: factors.consumer, energy: factors.energy },
      geographic: { northAmerica: factors.northAmerica, europe: factors.europe, asiaPacific: factors.asiaPacific, emergingMarkets: factors.emergingMarkets }
    };
  }

  /**
   * Split macros into Long vs Short contribution for decision making
   */
  static calculateLongShortFactors(holdings, totalValue) {
    const factors = {
      Rates: { long: 0, short: 0 },
      FX: { long: 0, short: 0 },
      Inflation: { long: 0, short: 0 },
      Growth: { long: 0, short: 0 },
      Credit: { long: 0, short: 0 },
      Equities: { long: 0, short: 0 },
      Commodities: { long: 0, short: 0 }
    };

    if (totalValue === 0) return factors;

    // Heuristic Factor Mapping
    const mapToFactor = (symbol, desc) => {
      if (symbol === 'TLT' || symbol === 'IEF' || symbol === 'BND') return 'Rates';
      if (symbol === 'UUP' || symbol === 'FXE' || desc.includes('CURRENCY')) return 'FX';
      if (symbol === 'GLD' || symbol === 'TIP' || desc.includes('GOLD')) return 'Inflation';
      if (symbol === 'HYG' || symbol === 'LQD' || desc.includes('BOND')) return 'Credit';
      if (symbol === 'SPY' || symbol === 'QQQ' || desc.includes('EQUITY')) return 'Equities';
      if (symbol === 'USO' || symbol === 'DBC' || desc.includes('OIL')) return 'Commodities';
      return 'Growth'; // Default bucket
    };

    holdings.forEach(h => {
      const val = h.marketValue || 0;
      const weight = (val / totalValue) * 100;
      const factor = mapToFactor((h.symbol || '').toUpperCase(), (h.description || '').toUpperCase());

      if (weight > 0) {
        factors[factor].long += weight;
      } else {
        factors[factor].short += Math.abs(weight);
      }
    });

    // Format
    Object.keys(factors).forEach(k => {
      factors[k].long = parseFloat(factors[k].long.toFixed(1));
      factors[k].short = parseFloat(factors[k].short.toFixed(1));
    });

    return factors;
  }

  /**
   * Calculate portfolio sensitivities (Beta, DV01 approximations)
   */
  static calculateSensitivityMetrics(holdings, totalValue) {
    // PROXY IMPLEMENTATION - in real app, this would use regression betas
    // We are essentially hardcoding betas for demonstration based on asset classes

    let ratesDV01 = 0;
    let fxBeta = 0;
    let equityBeta = 0; // Global
    let commBeta = 0;

    holdings.forEach(h => {
      const weight = (h.marketValue || 0) / totalValue;
      const sym = (h.symbol || '').toUpperCase();
      const desc = (h.description || '').toUpperCase();

      // Equity Beta Proxy
      if (sym === 'SPY' || sym === 'QQQ' || desc.includes('EQUITY')) {
        equityBeta += weight * 1.0;
      } else if (sym === 'IWM') {
        equityBeta += weight * 1.2;
      } else if (desc.includes('BOND')) {
        equityBeta += weight * 0.1;
      }

      // Rates DV01 Proxy (very rough approximation: 10yr duration for bonds)
      if (sym === 'IEF' || sym === 'TLT' || desc.includes('TREASURY')) {
        // Assume 1% move in rates approx 8% move in price for 10yr
        ratesDV01 += weight * 800; // basis points per 1% portfolio
      }

      // Commodity Beta (Oil/Gold)
      if (sym === 'USO' || sym === 'GLD' || desc.includes('COMMODITY')) {
        commBeta += weight * 1.0;
      }

      // FX Beta (USD) - Inverted for international
      if (desc.includes('INTERNATIONAL') || sym === 'EFA' || sym === 'EEM') {
        fxBeta -= weight * 0.5; // Short USD
      }
    });

    return {
      ratesBPV: Math.round(ratesDV01), // Basis Point Value
      fxBeta: parseFloat(fxBeta.toFixed(2)),
      equityBeta: parseFloat(equityBeta.toFixed(2)),
      commodityBeta: parseFloat(commBeta.toFixed(2))
    };
  }

  /**
   * Liquidity and Concentration Checks
   */
  static calculateLiquidityMetrics(holdings, totalValue) {
    // Mock ADV (Average Daily Volume) data
    // In production, fetch from API

    const liquidityBuckets = {
      'Liquid (<1 day)': 0,
      'Moderate (1-5 days)': 0,
      'Illiquid (>5 days)': 0
    };

    const riskContributors = holdings.map(h => {
      return {
        ticker: h.symbol,
        contribution: (Math.abs(h.marketValue || 0) / totalValue) * 100, // naive risk contrib
        daysToExit: Math.random() * 2 // Random mock for demo
      };
    }).sort((a, b) => b.contribution - a.contribution).slice(0, 5); // Top 5

    // Mock aggregation
    liquidityBuckets['Liquid (<1 day)'] = 85;
    liquidityBuckets['Moderate (1-5 days)'] = 12;
    liquidityBuckets['Illiquid (>5 days)'] = 3;

    return {
      buckets: liquidityBuckets,
      topRiskContributors: riskContributors
    };
  }

  /**
   * Scenario Analysis P&L estimates
   */
  static calculateScenarioAnalysis(holdings, totalValue) {
    // Estimated P&L % given simple shocks
    // Uses the sensitivities calculated previously as drivers

    const sensitivities = this.calculateSensitivityMetrics(holdings, totalValue);
    const eqBeta = sensitivities.equityBeta;
    const ratesSens = sensitivities.ratesBPV / 100; // approx % impact of 100bps? Very rough.
    const commBeta = sensitivities.commodityBeta;

    return [
      { name: "Equities -10%", impact: (eqBeta * -10).toFixed(1) + "%" },
      { name: "Rates +50bps", impact: (-1 * ratesSens * 0.5).toFixed(1) + "%" }, // bond prices fall
      { name: "USD +5%", impact: "-1.2%" }, // Hardcoded estimate
      { name: "Oil -20%", impact: (commBeta * -20 * 0.5).toFixed(1) + "%" },
      { name: "Credit Spreads +100bps", impact: "-2.5%" } // Hardcoded
    ];
  }

  /**
   * Helper methods for sector classification
   */
  static isTechnologySector(symbol, description) {
    const techKeywords = ['TECH', 'SOFTWARE', 'SEMICONDUCTOR', 'INTERNET', 'QQQ', 'XLK', 'NVDA', 'AAPL', 'MSFT'];
    return techKeywords.some(keyword =>
      symbol.includes(keyword) || description.toUpperCase().includes(keyword)
    );
  }

  static isHealthcareSector(symbol, description) {
    const healthKeywords = ['HEALTH', 'MEDICAL', 'PHARMA', 'BIO', 'XLV'];
    return healthKeywords.some(keyword =>
      symbol.includes(keyword) || description.toUpperCase().includes(keyword)
    );
  }

  static isFinancialSector(symbol, description) {
    const finKeywords = ['BANK', 'FINANCIAL', 'INSURANCE', 'XLF', 'JPM'];
    return finKeywords.some(keyword =>
      symbol.includes(keyword) || description.toUpperCase().includes(keyword)
    );
  }

  static isEnergySector(symbol, description) {
    const energyKeywords = ['ENERGY', 'OIL', 'GAS', 'XLE', 'XOM'];
    return energyKeywords.some(keyword =>
      symbol.includes(keyword) || description.toUpperCase().includes(keyword)
    );
  }

  static isInternational(symbol, description) {
    const intlKeywords = ['INTERNATIONAL', 'GLOBAL', 'FOREIGN', 'EW', 'EFA', 'EEM'];
    return intlKeywords.some(keyword =>
      symbol.includes(keyword) || description.toUpperCase().includes(keyword)
    );
  }

  /**
   * Calculate maximum drawdown (proxy)
   */
  static calculateMaxDrawdown(holdings) {
    // Simplified calculation without historical series access here
    // In a real app, this needs timeseries data
    return "5.2";
  }

  /**
   * Enhanced asset classification
   */
  static classifyAsset(holding) {
    const symbol = (holding.symbol || '').toUpperCase();
    const assetType = holding.assetType || '';

    // Enhanced classification logic
    if (assetType.includes('ETF') || assetType.includes('Fund')) {
      if (symbol.includes('QQQ') || symbol.includes('SPY') || symbol.includes('IWM')) {
        return { class: 'Equities', subClass: 'Broad Market ETF' };
      } else if (symbol.includes('XL') || symbol.includes('XLE') || symbol.includes('XLF')) {
        return { class: 'Equities', subClass: 'Sector ETF' };
      } else if (symbol.includes('EW') || symbol.includes('EFA') || symbol.includes('EEM')) {
        return { class: 'Equities', subClass: 'International ETF' };
      } else {
        return { class: 'Equities', subClass: 'Specialized ETF' };
      }
    } else if (assetType.includes('Equity')) {
      return { class: 'Equities', subClass: 'Individual Stock' };
    } else if (assetType.includes('Fixed Income') || symbol.includes('BOND')) {
      return { class: 'Fixed Income', subClass: 'Bond' };
    } else if (assetType.includes('Cash')) {
      return { class: 'Cash', subClass: 'Money Market' };
    } else {
      return { class: 'Other', subClass: 'Alternative' };
    }
  }
}
