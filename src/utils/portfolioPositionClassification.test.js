import { withPortfolioPositionClassification } from './portfolioPositionClassification';

test('shows the dashboard classification separately from the actual sizing basis without changing captured values', () => {
  const captured = { holding: 'DBMF', securityName: 'Captured DBMF name', sizingBasis: 'ATR sizing', minWeight: 3.25, maxWeight: 6.25, stopPrice: 96 };
  const row = withPortfolioPositionClassification(captured);
  expect(row).toMatchObject({ ...captured, classificationLabel: 'Managed Futures' });
  expect(row.classificationTitle).toContain('Current dashboard classification; MIN / MAX and the stop use the security’s own 14-day ATR.');
  expect(row.classificationTitle).not.toMatch(/beta|ATR cap/i);
  expect(captured).not.toHaveProperty('classificationLabel');
});

test('keeps IBIT cryptocurrency exposure while sizing it from its own ATR like every security', () => {
  const row = withPortfolioPositionClassification({ holding: 'IBIT', sizingBasis: 'ATR sizing' });
  expect(row.classificationLabel).toBe('Cryptocurrency');
  expect(row.classificationTitle).toContain('MIN / MAX and the stop use the security’s own 14-day ATR');
  expect(row.classificationTitle).not.toMatch(/commodity/i);
});

test('does not invent a classification or sizing basis for an unmapped security', () => {
  const row = withPortfolioPositionClassification({ holding: 'UNKNOWN' });
  expect(row.classificationLabel).toBeNull();
  expect(row.classificationTitle).toBe('Current dashboard classification.');
  expect(row).not.toHaveProperty('sizingBasis');
});
