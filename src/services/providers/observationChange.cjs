const number = (value) => (
  (typeof value === 'number' || (typeof value === 'string' && value.trim() !== ''))
    && Number.isFinite(Number(value)) ? Number(value) : null
);

function percentageChange(latest, previous) {
  const end = number(latest);
  const start = number(previous);
  if (end == null || start == null || start === 0) return null;
  // Absolute base preserves the direction of changes in negative spreads.
  return Math.round(((end - start) / Math.abs(start)) * 10000) / 100;
}

function latestObservationChange(closes, nowMs = Date.now()) {
  const byTime = new Map();
  for (const row of Array.isArray(closes) ? closes : []) {
    const t = number(row?.t);
    const close = number(row?.close);
    if (t != null && t > 0 && t <= nowMs && close != null) byTime.set(t, close);
  }
  const ordered = [...byTime].sort(([a], [b]) => a - b);
  if (ordered.length < 2) return null;
  const [from, previous] = ordered[ordered.length - 2];
  const [to, latest] = ordered[ordered.length - 1];
  const value = percentageChange(latest, previous);
  if (value == null) return null;
  const days = (to - from) / 86400000;
  return {
    value,
    from: new Date(from).toISOString(),
    asOf: new Date(to).toISOString(),
    interval: days <= 7 ? 'daily' : days >= 20 && days <= 40 ? 'monthly' : 'observation',
    status: 'historical',
    executable: false,
  };
}

module.exports = { percentageChange, latestObservationChange };
