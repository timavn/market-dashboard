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
      
      // Factor exposures
      ...this.calculateFactorExposures(holdings, totalValue)
    };
  }

  /**
   * Calculate risk metrics
   */
  static calculateRiskMetrics(holdings, totalValue) {
    // Calculate portfolio volatility (simplified)
    const returns = holdings.map(h => h.gainLossPercent || 0);
    const avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length;
    const volatility = Math.sqrt(variance);
    
    // Calculate Sharpe ratio (simplified - assumes 2% risk-free rate)
    const riskFreeRate = 2.0;
    const sharpeRatio = (avgReturn - riskFreeRate) / volatility;
    
    // Calculate VaR (simplified - 95% confidence)
    const sortedReturns = returns.sort((a, b) => a - b);
    const var95 = sortedReturns[Math.floor(sortedReturns.length * 0.05)];
    
    return {
      volatility: volatility.toFixed(2),
      sharpeRatio: sharpeRatio.toFixed(2),
      sortinoRatio: (avgReturn / volatility).toFixed(2), // Simplified
      var95: (totalValue * Math.abs(var95) / 100).toFixed(0),
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
    
    holdings.forEach(holding => {
      const weight = (holding.marketValue / totalValue) * 100;
      grossExposure += Math.abs(weight);
      
      if (holding.marketValue > 0) {
        netLongExposure += weight;
      } else {
        netShortExposure += Math.abs(weight);
      }
    });
    
    const netExposure = netLongExposure - netShortExposure;
    
    return {
      grossExposure: grossExposure.toFixed(1),
      netLongExposure: netLongExposure.toFixed(1),
      netShortExposure: netShortExposure.toFixed(1),
      netExposure: netExposure.toFixed(1)
    };
  }

  /**
   * Calculate concentration metrics
   */
  static calculateConcentrationMetrics(holdings, totalValue) {
    // Sort holdings by market value
    const sortedHoldings = [...holdings].sort((a, b) => b.marketValue - a.marketValue);
    
    // Top 10 holdings percentage
    const top10Value = sortedHoldings.slice(0, 10).reduce((sum, h) => sum + h.marketValue, 0);
    const top10Percent = (top10Value / totalValue) * 100;
    
    // Largest position percentage
    const largestPosition = sortedHoldings[0];
    const largestPositionPercent = (largestPosition.marketValue / totalValue) * 100;
    
    // HHI Index (Herfindahl-Hirschman Index)
    const hhi = holdings.reduce((sum, holding) => {
      const weight = (holding.marketValue / totalValue) * 100;
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
    const factors = {
      // Market cap exposure
      largeCap: 0,
      midCap: 0,
      smallCap: 0,
      
      // Sector exposure
      technology: 0,
      healthcare: 0,
      financials: 0,
      consumer: 0,
      industrials: 0,
      energy: 0,
      materials: 0,
      utilities: 0,
      realEstate: 0,
      communication: 0,
      
      // Style exposure
      growth: 0,
      value: 0,
      momentum: 0,
      
      // Geographic exposure
      northAmerica: 0,
      europe: 0,
      asiaPacific: 0,
      emergingMarkets: 0
    };
    
    holdings.forEach(holding => {
      const weight = (holding.marketValue / totalValue) * 100;
      
      // Map asset types to factors
      const description = holding.description || '';
      
      // Market cap classification (simplified)
      if (description.includes('ETF') || description.includes('FUND')) {
        factors.largeCap += weight * 0.7; // Assume ETFs are mostly large cap
        factors.midCap += weight * 0.2;
        factors.smallCap += weight * 0.1;
      } else {
        factors.largeCap += weight; // Individual stocks assumed large cap
      }
      
      // Sector classification (simplified based on symbols/descriptions)
      if (this.isTechnologySector(holding.symbol, description)) {
        factors.technology += weight;
      } else if (this.isHealthcareSector(holding.symbol, description)) {
        factors.healthcare += weight;
      } else if (this.isFinancialSector(holding.symbol, description)) {
        factors.financials += weight;
      } else if (this.isEnergySector(holding.symbol, description)) {
        factors.energy += weight;
      } else {
        factors.consumer += weight; // Default to consumer
      }
      
      // Geographic exposure (simplified)
      if (this.isInternational(holding.symbol, description)) {
        factors.europe += weight * 0.4;
        factors.asiaPacific += weight * 0.4;
        factors.emergingMarkets += weight * 0.2;
      } else {
        factors.northAmerica += weight;
      }
    });
    
    // Round all values
    Object.keys(factors).forEach(key => {
      factors[key] = factors[key].toFixed(1);
    });
    
    return factors;
  }

  /**
   * Helper methods for sector classification
   */
  static isTechnologySector(symbol, description) {
    const techKeywords = ['TECH', 'SOFTWARE', 'SEMICONDUCTOR', 'INTERNET', 'QQQ', 'XLK'];
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
    const finKeywords = ['BANK', 'FINANCIAL', 'INSURANCE', 'XLF'];
    return finKeywords.some(keyword => 
      symbol.includes(keyword) || description.toUpperCase().includes(keyword)
    );
  }

  static isEnergySector(symbol, description) {
    const energyKeywords = ['ENERGY', 'OIL', 'GAS', 'XLE'];
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
   * Calculate maximum drawdown (simplified)
   */
  static calculateMaxDrawdown(holdings) {
    // Simplified calculation - in reality you'd need historical data
    const totalGainLoss = holdings.reduce((sum, h) => sum + (h.gainLoss || 0), 0);
    const totalValue = holdings.reduce((sum, h) => sum + h.marketValue, 0);
    
    if (totalValue === 0) return '0.00';
    
    const maxDrawdown = Math.abs(Math.min(0, totalGainLoss / totalValue * 100));
    return maxDrawdown.toFixed(2);
  }

  /**
   * Enhanced asset classification
   */
  static classifyAsset(holding) {
    const symbol = holding.symbol || '';
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
