export const normalizeResearchDate = (value) => {
  if (!value) return null;
  const text = String(value).trim();
  const isoDate = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return isoDate ? isoDate[1] : null;
};

export const formatResearchSourceDate = (value) => {
  const date = normalizeResearchDate(value);
  if (!date) return 'Date unavailable';
  const parsed = new Date(`${date}T12:00:00Z`);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(parsed);
};

export const formatResearchTime = (value) => {
  if (!value || typeof value !== 'string' || !value.includes('T')) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  // Some legacy parsers stored a date-only artifact as midnight UTC. Do not
  // present that synthetic value as a publication time.
  if (/T00:00(?::00(?:\.000)?)?(?:Z|[+-]00:00)?$/i.test(value)) return '—';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(parsed);
};
