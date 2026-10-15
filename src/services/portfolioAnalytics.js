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
  static calculateRiskMetrics() {
    // Cross-sectional position gain/loss is not an account return series.
    return {
      volatility: null, sharpeRatio: null, sortinoRatio: null, var95: null, maxDrawdown: null,
      riskMetricsStatus: 'unavailable',
      riskMetricsReason: 'Verified account return history and benchmark inputs are required.'
    };
  }

  /**
   * Calculate exposure metrics
   */
  static calculateExposureMetrics(holdings, totalValue) {
    if (!Number.isFinite(totalValue) || totalValue <= 0) return {
      grossExposure: null, netLongExposure: null, netShortExposure: null, netExposure: null,
      longCount: null, shortCount: null
    };
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

    if (!Number.isFinite(totalValue) || totalValue <= 0) return {
      top10HoldingsPercent: null,
      largestPositionPercent: null,
      hhiIndex: null
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
  static calculateFactorExposures() {
    // A ticker/description cannot establish an ETF's underlying factor weights.
    return {
      marketCap: { largeCap: null, midCap: null, smallCap: null },
      sectors: { technology: null, healthcare: null, financials: null, consumer: null, energy: null },
      geographic: { northAmerica: null, europe: null, asiaPacific: null, emergingMarkets: null },
      factorExposureStatus: 'unavailable',
      factorExposureReason: 'Verified security classifications and fund constituent weights are required.'
    };
  }

  /**
   * Split macros into Long vs Short contribution for decision making
   */
  static calculateLongShortFactors() {
    return Object.fromEntries(['Rates', 'FX', 'Inflation', 'Growth', 'Credit', 'Equities', 'Commodities']
      .map((factor) => [factor, { long: null, short: null, status: 'unavailable' }]));
  }

  /**
   * Calculate portfolio sensitivities (Beta, DV01 approximations)
   */
  static calculateSensitivityMetrics() {
    return {
      ratesBPV: null, fxBeta: null, equityBeta: null, commodityBeta: null,
      status: 'unavailable', reason: 'Verified instrument sensitivities and aligned return history are required.'
    };
  }

  /**
   * Liquidity and Concentration Checks
   */
  static calculateLiquidityMetrics(holdings, totalValue) {
    const hasDenominator = Number.isFinite(totalValue) && totalValue > 0;
    const positions = [...holdings].sort((a, b) => Math.abs(b.marketValue || 0) - Math.abs(a.marketValue || 0));
    return {
      status: 'unavailable',
      reason: 'Verified trading volume and an explicit participation-rate assumption are required.',
      buckets: { 'Liquid (<1 day)': null, 'Moderate (1-5 days)': null, 'Illiquid (>5 days)': null },
      topRiskContributors: positions.slice(0, 5).map((holding) => ({
        ticker: holding.symbol,
        // Retain the legacy field, but identify it as position size, not model risk.
        contribution: hasDenominator && Number.isFinite(holding.marketValue)
          ? Math.abs(holding.marketValue) / totalValue * 100 : null,
        contributionBasis: 'absolute-position-value-percent-of-account',
        daysToExit: null
      }))
    };
  }

  /**
   * Scenario Analysis P&L estimates
   */
  static calculateScenarioAnalysis() {
    return ['Equities -10%', 'Rates +50bps', 'USD +5%', 'Oil -20%', 'Credit Spreads +100bps']
      .map((name) => ({ name, impact: null, status: 'unavailable', reason: 'Verified scenario model inputs are required.' }));
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
  static calculateMaxDrawdown() {
    return null; // Requires verified account equity history.
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
