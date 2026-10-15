import expectedValues from '../constants/expectedValuesData';
import { getExposureDefinition, getExposureQuadFit, resolveSecurityExposureProfile } from '../constants/quadExposureCatalog';

// Historical +EV and curated exposures describe a scenario. They do not
// authorize an entry or replace the independent Trade/Trend sizing rules.
export function portfolioReviewOutlook(brief) {
  const outlook = brief.quadOutlook;
  if (!outlook?.citation || ![1, 2, 3, 4].includes(outlook.to)) return null;
  const key = `q${outlook.to}`;
  const priorKey = [1, 2, 3, 4].includes(outlook.from) ? `q${outlook.from}` : null;
  const evaluated = (brief.holdings || []).map(holding => {
    const side = holding.heldSide === 'SHORT' ? -1 : 1;
    const values = expectedValues.getExpectedValueForTicker(holding.holding);
    if (values) return { ...holding, label: values.name, fit: values[key] * side,
      changed: priorKey ? (values[key] - values[priorKey]) * side : null };
    const profile = resolveSecurityExposureProfile(holding.holding);
    if (profile.classificationStatus !== 'reviewed') return null;
    const fit = getExposureQuadFit(profile.primaryExposureId, key);
    const previous = priorKey && getExposureQuadFit(profile.primaryExposureId, priorKey);
    const score = value => value?.status === 'best' ? 1 : value?.status === 'worst' ? -1 : 0;
    return { ...holding, label: getExposureDefinition(profile.primaryExposureId)?.label,
      fit: score(fit) * side, changed: priorKey ? score(fit) * side - score(previous) * side : null };
  }).filter(Boolean).sort((a, b) => (b.weightPct || 0) - (a.weightPct || 0));
  const pressure = evaluated.filter(row => row.fit < 0 || row.changed < 0);
  const support = evaluated.filter(row => row.fit > 0 && !(row.changed < 0));
  const candidates = (brief.opportunities || []).filter(row => row.trade === 'BULLISH' && row.trend === 'BULLISH')
    .map(row => ({ ...row, values: expectedValues.getExpectedValueForTicker(row.symbol) }))
    .filter(row => row.values && row.values[key] > 0 && (!priorKey || row.values[key] > row.values[priorKey]))
    .sort((a, b) => b.values[key] - a.values[key]).slice(0, 2);
  return { ...outlook, pressure, support, candidates, mapped: evaluated.length };
}
