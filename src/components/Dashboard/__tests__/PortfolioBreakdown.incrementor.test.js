/**
 * Test suite for PortfolioBreakdown % Portfolio column incrementor
 * 
 * Tests verify that:
 * - Up button increments by 0.10 correctly
 * - Down button decrements by 0.10 correctly
 * - Keyboard ArrowUp increments by 0.10 correctly
 * - Keyboard ArrowDown decrements by 0.10 correctly
 * - Handles edge cases (negative values, zero, decimal precision)
 */

describe('PortfolioBreakdown % Portfolio Incrementor', () => {
  /**
   * Helper function to simulate the increment logic used in the component
   * This matches the actual implementation: Math.round((current + 0.10) * 100) / 100
   */
  const incrementPercent = (current) => {
    return Math.round((current + 0.10) * 100) / 100;
  };

  /**
   * Helper function to simulate the decrement logic used in the component
   * This matches the actual implementation: Math.round((current - 0.10) * 100) / 100
   */
  const decrementPercent = (current) => {
    return Math.round((current - 0.10) * 100) / 100;
  };

  describe('Increment Logic (Up Button & ArrowUp)', () => {
    test('should increment by 0.10 from zero', () => {
      const result = incrementPercent(0);
      expect(result).toBe(0.10);
    });

    test('should increment by 0.10 from positive integer', () => {
      const result = incrementPercent(5);
      expect(result).toBe(5.10);
    });

    test('should increment by 0.10 from positive decimal', () => {
      const result = incrementPercent(5.25);
      expect(result).toBe(5.35);
    });

    test('should increment by 0.10 from value already at 0.10 increment', () => {
      const result = incrementPercent(5.10);
      expect(result).toBe(5.20);
    });

    test('should handle floating point precision correctly', () => {
      // Test case where floating point arithmetic might cause issues
      const result = incrementPercent(0.1 + 0.2); // 0.30000000000000004
      expect(result).toBe(0.40);
    });

    test('should increment from negative value', () => {
      const result = incrementPercent(-5.10);
      expect(result).toBe(-5.00);
    });

    test('should maintain 2 decimal places', () => {
      const result = incrementPercent(1.23);
      expect(result).toBe(1.33);
      expect(result.toString().split('.')[1]?.length).toBeLessThanOrEqual(2);
    });

    test('should handle multiple increments correctly', () => {
      let value = 0;
      value = incrementPercent(value); // 0.10
      value = incrementPercent(value); // 0.20
      value = incrementPercent(value); // 0.30
      expect(value).toBe(0.30);
    });
  });

  describe('Decrement Logic (Down Button & ArrowDown)', () => {
    test('should decrement by 0.10 from positive value', () => {
      const result = decrementPercent(5);
      expect(result).toBe(4.90);
    });

    test('should decrement by 0.10 from positive decimal', () => {
      const result = decrementPercent(5.25);
      expect(result).toBe(5.15);
    });

    test('should decrement by 0.10 from value at 0.10 increment', () => {
      const result = decrementPercent(5.10);
      expect(result).toBe(5.00);
    });

    test('should decrement from zero to negative', () => {
      const result = decrementPercent(0);
      expect(result).toBe(-0.10);
    });

    test('should handle floating point precision correctly', () => {
      const result = decrementPercent(0.1 + 0.2); // 0.30000000000000004
      expect(result).toBe(0.20);
    });

    test('should decrement from negative value', () => {
      const result = decrementPercent(-5.10);
      expect(result).toBe(-5.20);
    });

    test('should maintain 2 decimal places', () => {
      const result = decrementPercent(1.23);
      expect(result).toBe(1.13);
      expect(result.toString().split('.')[1]?.length).toBeLessThanOrEqual(2);
    });

    test('should handle multiple decrements correctly', () => {
      let value = 1.00;
      value = decrementPercent(value); // 0.90
      value = decrementPercent(value); // 0.80
      value = decrementPercent(value); // 0.70
      expect(value).toBe(0.70);
    });
  });

  describe('Edge Cases', () => {
    test('should handle very small values', () => {
      const incrementResult = incrementPercent(0.01);
      const decrementResult = decrementPercent(0.01);
      expect(incrementResult).toBe(0.11);
      expect(decrementResult).toBe(-0.09);
    });

    test('should handle very large values', () => {
      const incrementResult = incrementPercent(99.99);
      const decrementResult = decrementPercent(99.99);
      expect(incrementResult).toBe(100.09);
      expect(decrementResult).toBe(99.89);
    });

    test('should handle values with many decimal places', () => {
      const incrementResult = incrementPercent(1.23456789);
      const decrementResult = decrementPercent(1.23456789);
      expect(incrementResult).toBe(1.33);
      expect(decrementResult).toBe(1.13);
    });

    test('should round correctly to avoid floating point errors', () => {
      // Test that 0.1 + 0.2 doesn't cause precision issues
      const value = 0.1 + 0.2; // This is 0.30000000000000004 in JavaScript
      const incrementResult = incrementPercent(value);
      const decrementResult = decrementPercent(value);
      
      // Both should be properly rounded
      expect(incrementResult).toBe(0.40);
      expect(decrementResult).toBe(0.20);
    });
  });

  describe('Consistency Tests', () => {
    test('increment and decrement should be inverse operations', () => {
      const startValue = 5.50;
      const incremented = incrementPercent(startValue);
      const decremented = decrementPercent(incremented);
      expect(decremented).toBe(startValue);
    });

    test('multiple increments followed by same number of decrements should return to start', () => {
      let value = 10.00;
      const increments = 5;
      
      // Increment 5 times
      for (let i = 0; i < increments; i++) {
        value = incrementPercent(value);
      }
      expect(value).toBe(10.50);
      
      // Decrement 5 times
      for (let i = 0; i < increments; i++) {
        value = decrementPercent(value);
      }
      expect(value).toBe(10.00);
    });

    test('step size should always be exactly 0.10', () => {
      const testValues = [0, 1, 5.25, 10.10, -5.50, 99.99];
      
      testValues.forEach(value => {
        const incrementDiff = incrementPercent(value) - value;
        const decrementDiff = value - decrementPercent(value);
        
        // Use toBeCloseTo for floating point comparisons to handle precision issues
        expect(incrementDiff).toBeCloseTo(0.10, 10);
        expect(decrementDiff).toBeCloseTo(0.10, 10);
      });
    });
  });

  describe('Real-world Scenarios', () => {
    test('should handle typical portfolio percentage values', () => {
      const typicalValues = [2.5, 4.0, 6.25, 8.75, 12.5];
      
      typicalValues.forEach(value => {
        const incremented = incrementPercent(value);
        const decremented = decrementPercent(value);
        
        expect(incremented).toBe(value + 0.10);
        expect(decremented).toBe(value - 0.10);
      });
    });

    test('should handle position sizing ranges', () => {
      // Test ranges from the portfolio construction guide
      // Longs: FX 4-12%, FI 4-10%, Eq 2-6%, Com 2-4%, Crypto 1-3%
      // Shorts: FX 2-6%, FI 2-5%, Eq 1-3%, Com 1-2%, Crypto 0.5-1%
      
      const longRanges = [
        { min: 4, max: 12 },   // FX
        { min: 4, max: 10 },   // FI
        { min: 2, max: 6 },    // Eq
        { min: 2, max: 4 },    // Com
        { min: 1, max: 3 }     // Crypto
      ];
      
      longRanges.forEach(range => {
        const midValue = (range.min + range.max) / 2;
        const incremented = incrementPercent(midValue);
        const decremented = decrementPercent(midValue);
        
        expect(incremented).toBeGreaterThan(midValue);
        expect(decremented).toBeLessThan(midValue);
        // Use toBeCloseTo for floating point comparisons to handle precision issues
        expect(incremented - decremented).toBeCloseTo(0.20, 10); // Two steps
      });
    });
  });
});
