// Reuse unchanged JSON evidence after a fresh read without ignoring metadata,
// provenance, or corrected source values. This is memory identity, not a cache.
export function reuseAnalystEvidence(previous, incoming) {
  if (previous === incoming) return previous;
  if (!previous || !incoming || typeof previous !== 'object' || typeof incoming !== 'object'
    || Array.isArray(previous) !== Array.isArray(incoming)) return incoming;
  const keys = Object.keys(incoming);
  let unchanged = keys.length === Object.keys(previous).length;
  const result = Array.isArray(incoming) ? [] : { ...incoming };
  for (const key of keys) {
    result[key] = reuseAnalystEvidence(previous[key], incoming[key]);
    if (!Object.prototype.hasOwnProperty.call(previous, key) || result[key] !== previous[key]) unchanged = false;
  }
  return unchanged ? previous : result;
}
