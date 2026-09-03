const normalizeStatus = (value) => String(value || '').trim().toLowerCase();

const finiteNumber = (value) => {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const FORBIDDEN_REFERENCE_PROVENANCE = /(unavailable|error|offline|stale|cache|mock|seed|fallback|failed|synthetic|inferred)/;

export const RISK_RANGE_BAND_COLORS = Object.freeze({
  low: '#fee2e2',
  high: '#dcfce7',
});

/**
 * Build the same lower/upper-third treatment used by prediction-market charts.
 * Only an attributed, explicitly available LRR/HRR pair is accepted.
 */
export function buildRiskRangeThirdBands(references = []) {
  const verified = (Array.isArray(references) ? references : [])
    .map((reference) => ({
      ...reference,
      kind: normalizeStatus(reference?.kind),
      label: normalizeStatus(reference?.label),
      source: normalizeStatus(reference?.source),
      status: normalizeStatus(reference?.status),
      tone: normalizeStatus(reference?.tone),
      value: finiteNumber(reference?.value),
    }))
    .filter((reference) => (
      reference.kind === 'underlying'
      && reference.status === 'available'
      && Boolean(reference.source)
      && !FORBIDDEN_REFERENCE_PROVENANCE.test(`${reference.status} ${reference.source}`)
      && reference.value != null
    ));
  const low = verified.find((reference) => reference.label === 'lrr' && reference.tone === 'low');
  const high = verified.find((reference) => reference.label === 'hrr' && reference.tone === 'high');
  if (!low || !high || low.value >= high.value) return [];

  const third = (high.value - low.value) / 3;
  return [
    {
      key: 'lower-third',
      tone: 'low',
      y1: low.value,
      y2: low.value + third,
    },
    {
      key: 'upper-third',
      tone: 'high',
      y1: high.value - third,
      y2: high.value,
    },
  ];
}

