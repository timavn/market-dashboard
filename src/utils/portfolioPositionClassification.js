import { getExposureDefinition, resolveSecurityExposureProfile } from '../constants/quadExposureCatalog';

// Presentation-only catalog labels remain separate from the sizing rules,
// which also run on the API server against the captured numeric inputs.
export function withPortfolioPositionClassification(row) {
  const profile = resolveSecurityExposureProfile({ ...row, symbol: row.holding || row.symbol });
  const classification = getExposureDefinition(profile.primaryExposureId);
  const classificationTitle = [
    profile.classificationNote,
    row.sizingBasis ? `Current dashboard classification; MIN / MAX use ${row.sizingBasis === 'Beta sizing' ? 'SPY beta' : row.sizingBasis.toLowerCase()}, with a separate ATR cap on MAX.` : 'Current dashboard classification.',
    profile.reviewedAt ? `Classification reviewed ${profile.reviewedAt}.` : null,
  ].filter(Boolean).join(' ');
  return { ...row, classificationLabel: classification?.label || null, classificationTitle };
}
