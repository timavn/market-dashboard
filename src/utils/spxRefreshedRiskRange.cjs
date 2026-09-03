const NEW_YORK_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const parsed = Number(String(value).replace(/[$,%\s,]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function timestampMs(value) {
  if (value == null || value === '') return null;
  const parsed = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function dateKeyInNewYork(value) {
  const timestamp = timestampMs(value);
  if (timestamp == null) return null;
  const parts = Object.fromEntries(
    NEW_YORK_DATE_FORMATTER.formatToParts(new Date(timestamp))
      .map((part) => [part.type, part.value]),
  );
  return parts.year && parts.month && parts.day
    ? `${parts.year}-${parts.month}-${parts.day}`
    : null;
}

function stripMarkup(value = '') {
  return String(value)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeRangeObject(candidate = {}) {
  if (!candidate || typeof candidate !== 'object') return null;
  const low = finiteNumber(
    candidate.lrr ?? candidate.low ?? candidate.lower ?? candidate.lowEnd ?? candidate.min,
  );
  const high = finiteNumber(
    candidate.hrr ?? candidate.high ?? candidate.upper ?? candidate.highEnd ?? candidate.max,
  );
  if (low == null || high == null || low <= 0 || high <= 0 || low >= high) return null;
  return { low, high };
}

function parseRangeText(text = '') {
  const normalized = stripMarkup(text);
  if (!normalized) return null;

  const rangeLabel = /(?:SPX\s+refreshed\s+risk\s+range|refreshed\s+SPX\s+risk\s+range)/i;
  if (!rangeLabel.test(normalized)) return null;

  const number = '([0-9][0-9,]*(?:\\.[0-9]+)?)';
  const match = normalized.match(new RegExp(
    `${rangeLabel.source}\\s*(?:=|:|is|of)?\\s*\\$?${number}\\s*(?:-|–|—|to)\\s*\\$?${number}`,
    'i',
  ));
  if (!match) return null;
  return normalizeRangeObject({ low: match[1], high: match[2] });
}

function parseSpxRefreshedRiskRange({
  payload = null,
  refreshedRiskRange = null,
  subject = '',
  headline = '',
  signalPhrase = '',
  text = '',
  body = '',
  html = '',
} = {}) {
  const structured = normalizeRangeObject(
    refreshedRiskRange
      || payload?.refreshedRiskRange
      || payload?.spxRefreshedRiskRange
      || payload?.riskRange,
  );
  if (structured) return structured;

  return parseRangeText([
    subject,
    headline,
    signalPhrase,
    text,
    body,
    html,
  ].filter(Boolean).join('\n'));
}

function selectCurrentSpxRefreshedRiskRange(candidates = [], {
  now = Date.now(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
} = {}) {
  const nowMs = timestampMs(now);
  if (nowMs == null) return null;
  const today = dateKeyInNewYork(nowMs);
  const ageLimit = Number.isFinite(Number(maxAgeMs)) && Number(maxAgeMs) > 0
    ? Number(maxAgeMs)
    : DEFAULT_MAX_AGE_MS;

  return (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => {
      const range = normalizeRangeObject(candidate?.range || candidate);
      const asOf = candidate?.asOf || candidate?.eventTime || candidate?.receivedAt || null;
      const asOfMs = timestampMs(asOf);
      if (!range || asOfMs == null) return null;
      if (asOfMs > nowMs + 5 * 60 * 1000) return null;
      if (nowMs - asOfMs > ageLimit) return null;
      if (dateKeyInNewYork(asOfMs) !== today) return null;
      return {
        ...candidate,
        ...range,
        asOf: new Date(asOfMs).toISOString(),
        asOfMs,
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.asOfMs - right.asOfMs)
    .at(-1) || null;
}

module.exports = {
  DEFAULT_MAX_AGE_MS,
  dateKeyInNewYork,
  normalizeRangeObject,
  parseSpxRefreshedRiskRange,
  selectCurrentSpxRefreshedRiskRange,
  stripMarkup,
};
