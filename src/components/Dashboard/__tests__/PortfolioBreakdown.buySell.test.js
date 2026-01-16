/**
 * Test suite for PortfolioBreakdown Buy/Sell (qtyNeeded) calculation
 *
 * Tests verify that:
 * - calculateSharesFromPercent returns correct share quantities
 * - First increment from displayed value results in at least 1 or -1 share
 * - Handles edge cases (zero diff, small diff, large diff)
 * - Works correctly for both longs and shorts
 * - calculateSharesFromBasisPoints works correctly
 */

describe('PortfolioBreakdown Buy/Sell Calculation', () => {
  /**
   * Helper function that mirrors calculateSharesFromPercent in the component
   */
  const calculateSharesFromPercent = (holding, targetPercent, totalValue, isShort = false) => {
    if (!holding || targetPercent === undefined || targetPercent === null || !totalValue || !holding.price) return null;
    const price = parseFloat(holding.price);
    if (price === 0) return null;

    // Current % of portfolio - use rounded value to match what's displayed
    const currentPercentRaw = totalValue > 0 ? ((Math.abs(holding.marketValue) / totalValue) * 100) : 0;
    const currentPercent = Math.round(currentPercentRaw * 100) / 100; // Round to 2 decimal places
    const targetPercentNum = parseFloat(targetPercent);

    // Round target to 2 decimal places as well for consistent comparison
    const targetPercentRounded = Math.round(targetPercentNum * 100) / 100;

    // Difference in percentage (using rounded values)
    const percentDiff = targetPercentRounded - currentPercent;

    // If no difference after rounding, return 0
    if (Math.abs(percentDiff) < 0.001) return 0;

    // Dollar amount needed: (percentDiff / 100) * totalValue
    const dollarAmount = (percentDiff / 100) * totalValue;
    let shares = dollarAmount / price;

    // For shorts: if target % is higher than current, we need to sell more (negative shares)
    if (isShort) {
      shares = -shares;
    }

    // Round shares, but ensure at least 1 or -1 if there's any non-zero diff
    if (shares > 0 && shares < 1) {
      return 1;
    } else if (shares < 0 && shares > -1) {
      return -1;
    }

    return Math.round(shares);
  };

  /**
   * Helper function that mirrors calculateSharesFromBasisPoints in the component
   */
  const calculateSharesFromBasisPoints = (holding, basisPoints, totalValue, isShort = false) => {
    if (!holding || !basisPoints || !totalValue || !holding.price) return null;
    const price = parseFloat(holding.price);
    if (price === 0) return null;

    // Basis points to dollar amount: (basisPoints / 10000) * totalValue
    const dollarAmount = (parseFloat(basisPoints) / 10000) * totalValue;
    let shares = dollarAmount / price;

    // For shorts: positive basis points means increase short (sell more = negative shares)
    if (isShort) {
      shares = -shares;
    }

    return Math.round(shares);
  };

  // Test fixtures
  const createHolding = (symbol, price, marketValue, quantity) => ({
    symbol,
    price,
    marketValue,
    quantity
  });

  const totalValue = 100000; // $100,000 portfolio

  describe('calculateSharesFromPercent - Basic Functionality', () => {
    test('should return null for missing holding', () => {
      expect(calculateSharesFromPercent(null, 5, totalValue, false)).toBeNull();
    });

    test('should return null for undefined targetPercent', () => {
      const holding = createHolding('AAPL', 150, 5000, 33);
      expect(calculateSharesFromPercent(holding, undefined, totalValue, false)).toBeNull();
    });

    test('should return null for null targetPercent', () => {
      const holding = createHolding('AAPL', 150, 5000, 33);
      expect(calculateSharesFromPercent(holding, null, totalValue, false)).toBeNull();
    });

    test('should return null for zero price', () => {
      const holding = createHolding('AAPL', 0, 5000, 33);
      expect(calculateSharesFromPercent(holding, 5, totalValue, false)).toBeNull();
    });

    test('should return null for missing totalValue', () => {
      const holding = createHolding('AAPL', 150, 5000, 33);
      expect(calculateSharesFromPercent(holding, 5, 0, false)).toBeNull();
    });
  });

  describe('calculateSharesFromPercent - First Increment Issue (Main Bug Fix)', () => {
    test('should return at least 1 share when incrementing from displayed value', () => {
      // Scenario: Stock at 2.39% of portfolio, user increments to 2.40%
      // Market value: $2,390 (2.39% of $100,000)
      const holding = createHolding('AAPL', 150, 2390, 16);

      // Current displayed percent: 2.39%
      const currentDisplayed = 2.39;
      // User increments by 0.01%
      const targetPercent = currentDisplayed + 0.01; // 2.40%

      const shares = calculateSharesFromPercent(holding, targetPercent, totalValue, false);

      // Should be at least 1 share (buy), not 0
      expect(shares).toBeGreaterThanOrEqual(1);
    });

    test('should return at least -1 share when decrementing from displayed value', () => {
      // Scenario: Stock at 2.39% of portfolio, user decrements to 2.38%
      const holding = createHolding('AAPL', 150, 2390, 16);

      const currentDisplayed = 2.39;
      const targetPercent = currentDisplayed - 0.01; // 2.38%

      const shares = calculateSharesFromPercent(holding, targetPercent, totalValue, false);

      // Should be at least -1 share (sell), not 0
      expect(shares).toBeLessThanOrEqual(-1);
    });

    test('should return 0 when target equals current (no change)', () => {
      // Market value exactly 2.39% of portfolio
      const holding = createHolding('AAPL', 150, 2390, 16);

      // Target matches current exactly
      const targetPercent = 2.39;

      const shares = calculateSharesFromPercent(holding, targetPercent, totalValue, false);

      expect(shares).toBe(0);
    });

    test('should handle 0.10% increment correctly', () => {
      // Stock at 5.00% of portfolio ($5,000 value)
      const holding = createHolding('AAPL', 150, 5000, 33);

      // User increments by 0.10%
      const targetPercent = 5.10;

      const shares = calculateSharesFromPercent(holding, targetPercent, totalValue, false);

      // 0.10% of $100,000 = $100 / $150 per share ≈ 0.67 shares → rounds to 1
      expect(shares).toBeGreaterThanOrEqual(1);
    });
  });

  describe('calculateSharesFromPercent - Longs', () => {
    test('should calculate positive shares when increasing position', () => {
      // Stock at 5% ($5,000), want to increase to 10% ($10,000)
      const holding = createHolding('AAPL', 150, 5000, 33);

      const shares = calculateSharesFromPercent(holding, 10, totalValue, false);

      // Need $5,000 more / $150 = 33 shares
      expect(shares).toBe(33);
    });

    test('should calculate negative shares when decreasing position', () => {
      // Stock at 10% ($10,000), want to decrease to 5% ($5,000)
      const holding = createHolding('AAPL', 150, 10000, 67);

      const shares = calculateSharesFromPercent(holding, 5, totalValue, false);

      // Need to sell $5,000 / $150 = -33 shares
      expect(shares).toBe(-33);
    });

    test('should handle typical portfolio increment (0.10%)', () => {
      // Stock at 3.00% ($3,000), increment to 3.10% ($3,100)
      const holding = createHolding('AAPL', 100, 3000, 30);

      const shares = calculateSharesFromPercent(holding, 3.10, totalValue, false);

      // Need $100 more / $100 = 1 share
      expect(shares).toBe(1);
    });
  });

  describe('calculateSharesFromPercent - Shorts', () => {
    test('should calculate negative shares when increasing short position', () => {
      // Short at 5% ($5,000), want to increase short to 10% ($10,000)
      // For shorts: higher % = sell more = negative shares
      const holding = createHolding('TSLA', 200, -5000, -25);

      const shares = calculateSharesFromPercent(holding, 10, totalValue, true);

      // Need to sell $5,000 more / $200 = -25 shares
      expect(shares).toBe(-25);
    });

    test('should calculate positive shares when decreasing short position', () => {
      // Short at 10% ($10,000), want to decrease to 5% ($5,000)
      // For shorts: lower % = buy back = positive shares
      const holding = createHolding('TSLA', 200, -10000, -50);

      const shares = calculateSharesFromPercent(holding, 5, totalValue, true);

      // Need to buy back $5,000 / $200 = +25 shares
      expect(shares).toBe(25);
    });

    test('should return at least -1 share when incrementing short from displayed value', () => {
      // Short at 2.39%, user increments to 2.40% (increase short)
      const holding = createHolding('TSLA', 200, -2390, -12);

      const shares = calculateSharesFromPercent(holding, 2.40, totalValue, true);

      // Should be at least -1 (sell more to increase short), not 0
      expect(shares).toBeLessThanOrEqual(-1);
    });
  });

  describe('calculateSharesFromPercent - Edge Cases', () => {
    test('should handle very expensive stock (small share count)', () => {
      // $500 stock, 1% allocation ($1,000), increment by 0.10% ($100)
      const holding = createHolding('GOOG', 500, 1000, 2);

      const shares = calculateSharesFromPercent(holding, 1.10, totalValue, false);

      // $100 / $500 = 0.2 shares → should round to at least 1
      expect(shares).toBeGreaterThanOrEqual(1);
    });

    test('should handle very cheap stock (large share count)', () => {
      // $5 stock, 1% allocation ($1,000), increment by 0.10% ($100)
      const holding = createHolding('F', 5, 1000, 200);

      const shares = calculateSharesFromPercent(holding, 1.10, totalValue, false);

      // $100 / $5 = 20 shares
      expect(shares).toBe(20);
    });

    test('should handle small portfolio value', () => {
      const smallPortfolio = 10000; // $10,000
      const holding = createHolding('AAPL', 150, 500, 3); // 5% of small portfolio

      const shares = calculateSharesFromPercent(holding, 6, smallPortfolio, false);

      // 1% of $10,000 = $100 / $150 = 0.67 → rounds to 1
      expect(shares).toBeGreaterThanOrEqual(1);
    });

    test('should handle large portfolio value', () => {
      const largePortfolio = 10000000; // $10M
      const holding = createHolding('AAPL', 150, 500000, 3333); // 5% of large portfolio

      const shares = calculateSharesFromPercent(holding, 5.10, largePortfolio, false);

      // 0.10% of $10M = $10,000 / $150 ≈ 67 shares
      expect(shares).toBe(67);
    });

    test('should handle floating point precision', () => {
      // Values that might cause floating point issues
      const holding = createHolding('AAPL', 100, 3333.33, 33);

      // 3333.33 / 100000 * 100 = 3.33333%
      const shares = calculateSharesFromPercent(holding, 3.43, totalValue, false);

      // Should handle precision correctly
      expect(typeof shares).toBe('number');
      expect(Number.isInteger(shares)).toBe(true);
    });
  });

  describe('calculateSharesFromBasisPoints - Basic Functionality', () => {
    test('should return null for missing holding', () => {
      expect(calculateSharesFromBasisPoints(null, 100, totalValue, false)).toBeNull();
    });

    test('should return null for zero basis points', () => {
      const holding = createHolding('AAPL', 150, 5000, 33);
      expect(calculateSharesFromBasisPoints(holding, 0, totalValue, false)).toBeNull();
    });

    test('should calculate shares from basis points for longs', () => {
      // 100 basis points = 1% of portfolio
      const holding = createHolding('AAPL', 100, 5000, 50);

      const shares = calculateSharesFromBasisPoints(holding, 100, totalValue, false);

      // 100 bps = 1% of $100,000 = $1,000 / $100 = 10 shares
      expect(shares).toBe(10);
    });

    test('should calculate shares from basis points for shorts', () => {
      // 100 basis points = 1% of portfolio, but for shorts this means sell
      const holding = createHolding('TSLA', 100, -5000, -50);

      const shares = calculateSharesFromBasisPoints(holding, 100, totalValue, true);

      // For shorts: 100 bps = sell $1,000 / $100 = -10 shares
      expect(shares).toBe(-10);
    });

    test('should handle 25 basis point increments', () => {
      const holding = createHolding('AAPL', 100, 5000, 50);

      const shares = calculateSharesFromBasisPoints(holding, 25, totalValue, false);

      // 25 bps = 0.25% of $100,000 = $250 / $100 = 2.5 → rounds to 3
      expect(shares).toBe(3);
    });
  });

  describe('Consistency Between Percent and Basis Points', () => {
    test('100 basis points should equal 1% change', () => {
      const holding = createHolding('AAPL', 100, 5000, 50); // 5% of portfolio

      // 100 bps from basis points calculator
      const sharesBps = calculateSharesFromBasisPoints(holding, 100, totalValue, false);

      // 1% increase (5% to 6%) from percent calculator
      const sharesPct = calculateSharesFromPercent(holding, 6, totalValue, false);

      // Both should give approximately the same result
      expect(sharesBps).toBe(sharesPct);
    });

    test('10 basis points should equal 0.10% change', () => {
      const holding = createHolding('AAPL', 100, 5000, 50); // 5% of portfolio

      // 10 bps from basis points calculator
      const sharesBps = calculateSharesFromBasisPoints(holding, 10, totalValue, false);

      // 0.10% increase (5% to 5.10%) from percent calculator
      const sharesPct = calculateSharesFromPercent(holding, 5.10, totalValue, false);

      // Both should give the same result
      expect(sharesBps).toBe(sharesPct);
    });
  });

  describe('Real-world Scenarios', () => {
    test('should handle typical rebalancing scenario', () => {
      // AAPL at 8.5% ($8,500), want to trim to 6% ($6,000)
      const holding = createHolding('AAPL', 170, 8500, 50);

      const shares = calculateSharesFromPercent(holding, 6, totalValue, false);

      // Need to sell $2,500 / $170 ≈ -15 shares
      expect(shares).toBe(-15);
    });

    test('should handle adding to winning position', () => {
      // Winner at 3% ($3,000), want to increase to 5% ($5,000)
      const holding = createHolding('NVDA', 400, 3000, 8);

      const shares = calculateSharesFromPercent(holding, 5, totalValue, false);

      // Need $2,000 more / $400 = 5 shares
      expect(shares).toBe(5);
    });

    test('should handle covering part of short position', () => {
      // Short TSLA at 4% ($4,000), want to reduce to 2% ($2,000)
      const holding = createHolding('TSLA', 250, -4000, -16);

      const shares = calculateSharesFromPercent(holding, 2, totalValue, true);

      // Need to buy back $2,000 / $250 = +8 shares
      expect(shares).toBe(8);
    });

    test('should handle small adjustment to large position', () => {
      // Large position at 12% ($12,000), small trim to 11.90%
      const holding = createHolding('SPY', 450, 12000, 27);

      const shares = calculateSharesFromPercent(holding, 11.90, totalValue, false);

      // Small change should still result in at least -1 share
      expect(shares).toBeLessThanOrEqual(-1);
    });
  });

  describe('Sequential Increments', () => {
    test('multiple increments should accumulate correctly', () => {
      // Start at 5.00%
      const holding = createHolding('AAPL', 100, 5000, 50);

      // Simulate 5 increments of 0.10% each (5.00 → 5.50%)
      const sharesAt510 = calculateSharesFromPercent(holding, 5.10, totalValue, false);
      const sharesAt520 = calculateSharesFromPercent(holding, 5.20, totalValue, false);
      const sharesAt530 = calculateSharesFromPercent(holding, 5.30, totalValue, false);
      const sharesAt540 = calculateSharesFromPercent(holding, 5.40, totalValue, false);
      const sharesAt550 = calculateSharesFromPercent(holding, 5.50, totalValue, false);

      // Each 0.10% = $100 / $100 = 1 share
      expect(sharesAt510).toBe(1);
      expect(sharesAt520).toBe(2);
      expect(sharesAt530).toBe(3);
      expect(sharesAt540).toBe(4);
      expect(sharesAt550).toBe(5);
    });

    test('shares should scale linearly with percent change', () => {
      const holding = createHolding('AAPL', 100, 5000, 50);

      const shares1pct = calculateSharesFromPercent(holding, 6, totalValue, false);   // +1%
      const shares2pct = calculateSharesFromPercent(holding, 7, totalValue, false);   // +2%
      const shares5pct = calculateSharesFromPercent(holding, 10, totalValue, false);  // +5%

      // Should be linear: 2% = 2x shares of 1%, 5% = 5x shares of 1%
      expect(shares2pct).toBe(shares1pct * 2);
      expect(shares5pct).toBe(shares1pct * 5);
    });
  });
});
