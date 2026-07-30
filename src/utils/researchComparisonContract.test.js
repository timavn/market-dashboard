import { isExplicitlySafeResearchComparison } from './researchComparisonContract';

const SAFE = {
  current: true,
  comparisonSafe: true,
  referenceOnly: false,
  dataAvailability: {
    canonicalSourceVerified: true,
    current: true,
    comparisonSafe: true,
    referenceOnly: false,
  },
};

describe('research comparison UI contract', () => {
  test('requires affirmative and consistent canonical/current metadata', () => {
    expect(isExplicitlySafeResearchComparison(SAFE)).toBe(true);
    expect(isExplicitlySafeResearchComparison({})).toBe(false);
    expect(isExplicitlySafeResearchComparison({
      ...SAFE,
      comparisonSafe: undefined,
    })).toBe(false);
    expect(isExplicitlySafeResearchComparison({
      ...SAFE,
      dataAvailability: {
        ...SAFE.dataAvailability,
        current: false,
      },
    })).toBe(false);
    expect(isExplicitlySafeResearchComparison({
      ...SAFE,
      meta: { canonicalSourceVerified: false },
    })).toBe(false);
  });
});
