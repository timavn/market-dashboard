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

// These are dated published or operator-entered research readings. Never substitute a
// sample chart, country-mode calculation, or prior-period reading for a current quad.
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
    const valid = sourced
      && [1, 2, 3, 4].includes(reading.quad)
      && validDate && date <= today && periodFor(date, id) === periodFor(today, id);
    return [id, valid ? reading : null];
  }));
}

export function loadPortfolioQuadReadings() {
  let saved = {};
  try {
    saved = JSON.parse(window.localStorage.getItem(PORTFOLIO_QUAD_READINGS_KEY)) || {};
  } catch (_error) {
    // The independently sourced published reference remains available when
    // browser storage is unavailable or corrupt.
  }
  return Object.fromEntries(QUAD_READING_SCOPES.map(({ id }) => {
    const published = HEDGEYE_QUAD_READINGS[id];
    const override = saved[id];
    // A newer published update supersedes an older manually entered reading.
    const useOverride = Object.prototype.hasOwnProperty.call(saved, id)
      && (override === null || (override?.asOf || '') >= (published?.asOf || ''));
    return [id, useOverride ? override : published];
  }));
}
import { HEDGEYE_QUAD_READINGS } from '../constants/hedgeyeQuadReadings';
