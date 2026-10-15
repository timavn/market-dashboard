import { withPortfolioPositionClassification } from './portfolioPositionClassification';

test('shows the dashboard classification separately from the actual sizing basis without changing captured values', () => {
  const captured = { holding: 'DBMF', securityName: 'Captured DBMF name', sizingBasis: 'Beta sizing', minWeight: 4, maxWeight: 12 };
  const row = withPortfolioPositionClassification(captured);
  expect(row).toMatchObject({ ...captured, classificationLabel: 'Managed Futures' });
  expect(row.classificationTitle).toContain('MIN / MAX use SPY beta');
  expect(row.classificationTitle).toContain('separate ATR cap on MAX');
  expect(captured).not.toHaveProperty('classificationLabel');
});

test('preserves the distinction between IBIT cryptocurrency exposure and its commodity sizing policy', () => {
  const row = withPortfolioPositionClassification({ holding: 'IBIT', sizingBasis: 'Commodity policy' });
  expect(row.classificationLabel).toBe('Cryptocurrency');
  expect(row.classificationTitle).toContain('MIN / MAX use commodity policy');
});

test('does not invent a classification or sizing basis for an unmapped security', () => {
  const row = withPortfolioPositionClassification({ holding: 'UNKNOWN' });
  expect(row.classificationLabel).toBeNull();
  expect(row.classificationTitle).toBe('Current dashboard classification.');
  expect(row).not.toHaveProperty('sizingBasis');
});
