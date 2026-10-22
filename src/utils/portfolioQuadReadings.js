export const PORTFOLIO_QUAD_READINGS_KEY = 'marketDashboard.portfolioQuadReadings.v1';

export const QUAD_READING_SCOPES = Object.freeze([
  { id: 'usMonthly', label: 'U.S. Monthly' },
  { id: 'usQuarterly', label: 'U.S. Quarterly' },
  { id: 'global', label: 'Global' },
]);

export const quadReadingDate = (now = new Date()) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(now);

const periodFor = (date, scope) => scope === 'usMonthly'
  ? date.slice(0, 7)
  : `${date.slice(0, 4)}-Q${Math.ceil(Number(date.slice(5, 7)) / 3)}`;

const previousMonth = date => {
  const [year, month] = date.split('-').map(Number);
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`;
};

// These are dated published or operator-entered research readings. Never substitute a
// sample chart, country-mode calculation, or prior-period reading for a current quad.
// The one exception is last month's published monthly call for this month, which stands
// until this month's update replaces it.
export function currentPortfolioQuadReadings(readings, today = quadReadingDate()) {
  return Object.fromEntries(QUAD_READING_SCOPES.map(({ id }) => {
    const reading = readings?.[id];
    const date = reading?.asOf;
    const validDate = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
      && !Number.isNaN(Date.parse(`${date}T12:00:00Z`))
      && new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) === date;
    const sourced = reading?.source === 'manual-hedgeye'
      || (reading?.source === 'hedgeye-published' && Boolean(reading.sourceLabel)
        && /^https:\/\/mail\.google\.com\/mail\/#all\/[a-z0-9]+$/.test(reading.sourceUrl || ''));
    const current = periodFor(today, id);
    const forecast = validDate && id === 'usMonthly' && reading.source === 'hedgeye-published'
      && reading.period === current && date.slice(0, 7) === previousMonth(today);
    const valid = sourced
      && [1, 2, 3, 4].includes(reading.quad)
      && validDate && date <= today && (reading.period ?? current) === current
      && (periodFor(date, id) === current || forecast);
    return [id, valid ? reading : null];
  }));
}

// The /api/hedgeye/monthly-quad reading for this month, shaped as a published reading.
export function publishedQuadReadings(payload, today = quadReadingDate()) {
  const usMonthly = payload?.schemaVersion === 1 ? payload.readings?.[today.slice(0, 7)] : null;
  return usMonthly ? { usMonthly } : {};
}

// `fetched` holds readings parsed from the emails; the newer of it and the bundled
// reference is the published reading for each scope.
export function loadPortfolioQuadReadings(fetched = {}) {
  let saved = {};
  try {
    saved = JSON.parse(window.localStorage.getItem(PORTFOLIO_QUAD_READINGS_KEY)) || {};
  } catch (_error) {
    // The independently sourced published reference remains available when
    // browser storage is unavailable or corrupt.
  }
  return Object.fromEntries(QUAD_READING_SCOPES.map(({ id }) => {
    const bundled = HEDGEYE_QUAD_READINGS[id];
    const published = (fetched?.[id]?.asOf || '') > (bundled?.asOf || '') ? fetched[id] : bundled;
    const override = saved[id];
    // A newer published update supersedes an older manually entered reading. A saved
    // copy of a published reading never overrides the current published one.
    const useOverride = Object.prototype.hasOwnProperty.call(saved, id)
      && (override === null || (override?.source === 'manual-hedgeye' && (override.asOf || '') >= (published?.asOf || '')));
    return [id, useOverride ? override : published];
  }));
}
import { HEDGEYE_QUAD_READINGS } from '../constants/hedgeyeQuadReadings';
