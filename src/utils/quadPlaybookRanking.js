import {
  EXPOSURE_DIMENSIONS,
  getExposureDefinition,
  resolveSecurityExposureProfile,
} from '../constants/quadExposureCatalog';

export const QUAD_RANKING_METHOD = 'quad-playbook-order-v1';

// These are ordinal positions in the four-quad chart, not quarterly returns.
// #1 in a Best list is strongest; #1 in a Worst list is weakest.
const fitSortKey = ({ status, rank }) => (
  status === 'best' ? [0, rank] : status === 'worst' ? [2, -rank] : [1, 0]
);

export function rankExposureQuads(exposureId) {
  const exposure = getExposureDefinition(exposureId);
  if (!exposure) return null;
  const fits = [1, 2, 3, 4].map(quad => ({ quad, ...exposure.quadFits[`q${quad}`] }));
  if (fits.every(fit => fit.status === 'not-listed')) return null;
  fits.sort((left, right) => {
    const a = fitSortKey(left);
    const b = fitSortKey(right);
    return a[0] - b[0] || a[1] - b[1] || left.quad - right.quad;
  });
  const groups = [];
  fits.forEach(fit => {
    const previous = groups.at(-1);
    if (previous && previous[0].status === fit.status && previous[0].rank === fit.rank) {
      previous.push(fit);
    } else groups.push([fit]);
  });
  return {
    exposure,
    dimensionLabel: EXPOSURE_DIMENSIONS[exposure.dimension].label,
    fits,
    groups,
    order: fits.map(fit => fit.quad),
    orderText: groups.map(group => group.map(fit => fit.quad).join(' = ')).join(' → '),
    hasTies: groups.some(group => group.length > 1),
    method: QUAD_RANKING_METHOD,
  };
}

export function getSecurityQuadPlaybookRanking(position) {
  const profile = resolveSecurityExposureProfile(position);
  const exposure = getExposureDefinition(profile.primaryExposureId);
  const ranking = profile.classificationStatus === 'reviewed'
    ? rankExposureQuads(profile.primaryExposureId) : null;
  return {
    profile,
    exposure,
    ranking,
    status: ranking ? 'ranked' : exposure ? 'not-covered' : 'unclassified',
    reason: ranking ? null : exposure
      ? `${exposure.label} is not covered by the four-quad +EV chart.`
      : 'This security needs a reviewed +EV factor classification.',
  };
}
