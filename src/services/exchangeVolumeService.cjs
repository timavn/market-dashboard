const axios = require('axios');
const { parseCsvText } = require('../utils/marketStructureVolume.cjs');
const { isTradingDateKey, previousTradingDateKey } = require('../utils/usEquityMarketCalendar.cjs');
const {
  EXCHANGE_VOLUME_METHODOLOGY,
  EXCHANGE_VOLUME_WINDOWS,
  EXCHANGE_VOLUME_SOURCE,
  EXCHANGE_VOLUME_SOURCE_TYPE,
  calculateExchangeVolumeMetrics,
  emptyVolumeMetrics,
  expectedVolumeTradingDate,
  hasUnverifiedVolumeFlags,
} = require('../utils/exchangeVolume.cjs');

const CBOE_VOLUME_URL = year => `https://cdn.cboe.com/resources/us/equities/market-statistics/historical-market-volume/market_history_${year}.csv`;
const SHARE_FIELDS = ['Tape A Shares', 'Tape B Shares', 'Tape C Shares', 'Total Shares'];

function volumeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function requiredVolumeDates(targetDate) {
  const dates = [targetDate];
  while (dates.length <= EXCHANGE_VOLUME_WINDOWS.avg1Y) dates.push(previousTradingDateKey(dates[dates.length - 1]));
  return dates;
}

function parseCboeVolumeCsv(text, { targetDate, year }) {
  if (typeof text !== 'string' || !text.trim() || /<html|<!doctype/i.test(text)) throw volumeError('CBOE_VOLUME_INVALID_CSV');
  const rows = parseCsvText(text.replace(/^\uFEFF/, ''));
  if (!rows.length || !['Day', 'Market Participant', ...SHARE_FIELDS].every(field => Object.hasOwn(rows[0], field))) {
    throw volumeError('CBOE_VOLUME_INVALID_CSV');
  }
  const daily = new Map();
  const seen = new Set();
  for (const row of rows) {
    const date = row.Day.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number(date.slice(0, 4)) !== year || !isTradingDateKey(date)) {
      throw volumeError('CBOE_VOLUME_INVALID_DATE');
    }
    if (date > targetDate) continue;
    const participant = row['Market Participant'].trim();
    const key = `${date}:${participant}`;
    if (!participant || seen.has(key) || hasUnverifiedVolumeFlags(row)) throw volumeError('CBOE_VOLUME_INVALID_PARTICIPANT');
    seen.add(key);
    const values = SHARE_FIELDS.map(field => {
      const raw = String(row[field] ?? '').trim();
      return /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : NaN;
    });
    if (!values.every(value => Number.isFinite(value) && value >= 0)
      || Math.abs(values[0] + values[1] + values[2] - values[3]) > 0.01) {
      throw volumeError('CBOE_VOLUME_INVALID_SHARES');
    }
    // Every participant contributes, including all FINRA TRFs. These are
    // consolidated listed-security shares, not only trades executed on exchanges.
    const session = daily.get(date) || { volume: 0, participants: new Set() };
    session.volume += values[3];
    session.participants.add(participant);
    daily.set(date, session);
  }
  return [...daily].map(([date, session]) => ({
    date, volume: session.volume, participants: [...session.participants],
  })).sort((a, b) => b.date.localeCompare(a.date));
}


function incompleteParticipantDates(rows, targetDate) {
  const byDate = new Map(rows.map(row => [row.date, row]));
  const newerByDate = new Map(rows.map(row => [previousTradingDateKey(row.date), row]));
  const incomplete = new Set();
  for (const row of rows) {
    const previous = byDate.get(previousTradingDateKey(row.date));
    if (!previous) continue;
    const participants = new Set(row.participants);
    const newer = newerByDate.get(row.date);
    // The latest session has no finalized newer neighbor. Require the prior
    // session's roster; a genuine venue retirement may be unavailable for a day.
    const expectedParticipants = row.date === targetDate
      ? previous.participants
      : previous.participants.filter(participant => newer?.participants.includes(participant));
    if (expectedParticipants.some(participant => !participants.has(participant))) incomplete.add(row.date);
  }
  // This detects isolated omissions. Repeated omissions across adjacent dates
  // cannot be distinguished from a genuine roster change without another source.
  return incomplete;
}

function volumeMetadata(targetDate, fetchedAt, status, extra = {}) {
  return {
    status,
    verified: status === 'current',
    provider: 'Cboe',
    sourceType: EXCHANGE_VOLUME_SOURCE_TYPE,
    methodologyVersion: EXCHANGE_VOLUME_METHODOLOGY,
    asOfTradingDate: status === 'current' ? targetDate : null,
    expectedTradingDate: targetDate,
    fetchedAt,
    comparisonWindows: EXCHANGE_VOLUME_WINDOWS,
    sourceBreakdown: [EXCHANGE_VOLUME_SOURCE],
    ...extra,
  };
}

function unavailableVolume(targetDate, now, errorCode) {
  return {
    asOf: null,
    totalMarket: [],
    totalExchange: [],
    metrics: { exchange: emptyVolumeMetrics() },
    meta: volumeMetadata(targetDate, new Date(now).toISOString(), 'unavailable', { errorCode }),
  };
}

function createExchangeVolumeService({ axiosClient = axios, now = () => new Date() } = {}) {
  const pending = new Map();

  async function loadSnapshot(targetDate, days) {
    const dates = requiredVolumeDates(targetDate);
    // Include a preceding roster neighbor for the oldest averaging input, even
    // when that neighbor belongs to another annual file.
    const coverageDates = [...dates, previousTradingDateKey(dates[dates.length - 1])];
    const years = [...new Set(coverageDates.map(date => Number(date.slice(0, 4))))];
    const results = await Promise.all(years.map(async year => {
      const url = CBOE_VOLUME_URL(year);
      const response = await axiosClient.get(url, {
        timeout: 20000,
        responseType: 'text',
        headers: { 'User-Agent': 'market-dashboard/exchange-volume' },
      });
      if ((response.status != null && response.status !== 200) || hasUnverifiedVolumeFlags(response)
        || hasUnverifiedVolumeFlags(response.meta)) throw volumeError('CBOE_VOLUME_UNVERIFIED_RESPONSE');
      return { url, rows: parseCboeVolumeCsv(response.data, { targetDate, year }) };
    }));
    const verifiedAt = new Date(now());
    if (expectedVolumeTradingDate(verifiedAt) !== targetDate) throw volumeError('CBOE_VOLUME_SESSION_CHANGED');
    const rows = results.flatMap(result => result.rows).sort((a, b) => b.date.localeCompare(a.date));
    const incompleteDates = incompleteParticipantDates(rows, targetDate);
    const displayRows = rows.map(({ date, volume }) => ({
      date, volume: incompleteDates.has(date) ? null : volume,
    }));
    const byDate = new Map(displayRows.map(row => [row.date, row.volume]));
    // Calendar slots preserve missing sessions; removing them would shift every
    // averaging window and make incomplete history appear complete.
    const metrics = calculateExchangeVolumeMetrics(dates.map(date => byDate.get(date) ?? null));
    if (!(byDate.get(targetDate) > 0) || metrics.pctPriorDay == null) throw volumeError('CBOE_VOLUME_SESSION_UNAVAILABLE');
    return {
      asOf: targetDate,
      totalMarket: [],
      totalExchange: displayRows.slice(0, days),
      metrics: { exchange: metrics },
      meta: volumeMetadata(targetDate, verifiedAt.toISOString(), 'current', { sourceUrls: results.map(result => result.url) }),
    };
  }

  function fetchSnapshot({ days = 365 } = {}) {
    const targetDate = expectedVolumeTradingDate(now());
    const limit = Math.max(2, Math.min(1000, Math.trunc(Number(days)) || 365));
    const key = `${targetDate}:${limit}`;
    if (pending.has(key)) return pending.get(key);
    const request = loadSnapshot(targetDate, limit)
      .catch(error => unavailableVolume(targetDate, now(), error.code || 'CBOE_VOLUME_FETCH_FAILED'))
      .finally(() => { pending.delete(key); });
    pending.set(key, request);
    return request;
  }

  return { fetchSnapshot };
}

module.exports = { CBOE_VOLUME_URL, createExchangeVolumeService, parseCboeVolumeCsv, requiredVolumeDates };
