'use strict';

const { normalizeMomoTrackerSnapshot, newYorkDateKey } = require('./momoTrackerSnapshot.cjs');
const { canonicalMomoCompanyTicker, MOMO_EXCLUDED_TICKERS } = require('../constants/momoTrackerCatalog.cjs');
const { isTradingDateKey, previousTradingDateKey } = require('../utils/usEquityMarketCalendar.cjs');

const MAX_AGE_MS = 20 * 60_000;
const BLOCKED_FLAGS = [
  'mock', 'isMock', 'seed', 'seeded', 'isSeed', 'stale', 'isStale', 'cacheOnly', 'isCacheOnly',
  'fromCache', 'refreshFailed', 'offline', 'disconnected', 'synthetic', 'fallback', 'isFallback',
  'modelOnly', 'portfolioDerived', 'inferred', 'costBasisDerived',
];

function blocked(value) {
  return !value || BLOCKED_FLAGS.some(key => value[key] === true)
    || value.connected === false || value.available === false
    || /unavailable|error|offline|disconnect|stale|mock|seed|synthetic|portfolio|cost.basis|cache|fallback|model.only|inferred|failed/i.test(
      [value.status, value.source, value.warning, value.error, value.freshness, value.provenance, value.dataStatus]
        .filter(item => typeof item === 'string').join(' '),
    );
}

function recent(timestamp, nowMs) {
  const age = nowMs - Date.parse(timestamp || '');
  return Number.isFinite(age) && age >= -5_000 && age <= MAX_AGE_MS;
}

function officialUrl(value, host) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      && (url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch { return false; }
}

function verifiedMarketCap(cap, nowMs) {
  return !blocked(cap) && cap.status === 'available' && cap.source === 'Nasdaq'
    && officialUrl(cap.sourceUrl, 'nasdaq.com') && cap.currency === 'USD'
    && cap.scope === 'company' && cap.timestampKind === 'retrieved'
    && typeof cap.value === 'number' && Number.isFinite(cap.value) && cap.value > 0
    && recent(cap.fetchedAt, nowMs);
}

function verifiedRows(rows, nowMs, { ranked = false } = {}) {
  return Array.isArray(rows) && rows.every((row, index) => !blocked(row)
    && /^[A-Z][A-Z0-9.]{0,9}$/.test(row.ticker)
    && !MOMO_EXCLUDED_TICKERS.includes(row.ticker)
    && (!ranked || canonicalMomoCompanyTicker(row.ticker) === row.ticker)
    && verifiedMarketCap(row.marketCap, nowMs)
    && (!ranked || row.rank === index + 1)
    && (row.weightPct == null || (typeof row.weightPct === 'number'
      && Number.isFinite(row.weightPct) && row.weightPct > 0 && row.weightPct < 100))
    && (index === 0 || rows[index - 1].marketCap.value >= row.marketCap.value))
    && new Set(rows.map(row => canonicalMomoCompanyTicker(row.ticker))).size === rows.length;
}

function result(status, date, reason, top10Tickers = [], momoAdditionalTickers = []) {
  return { status, date, top10Tickers, momoAdditionalTickers, ...(reason ? { reason } : {}) };
}

function validateMomoRoster(snapshot, { nowMs = Date.now() } = {}) {
  const date = newYorkDateKey(nowMs);
  if (!isTradingDateKey(date)) return result('skipped', date, 'non_trading_day');
  const currentPublication = value => isTradingDateKey(value)
    && [date, previousTradingDateKey(date)].includes(value);
  if (blocked(snapshot) || snapshot.status !== 'available'
    || snapshot.ranking !== 'company-market-cap' || snapshot.rankingSource !== 'Nasdaq'
    || !officialUrl(snapshot.rankingSourceUrl, 'nasdaq.com')
    || !String(snapshot.source || '').includes('State Street')
    || !officialUrl(snapshot.sourceUrl, 'ssga.com')
    || !officialUrl(snapshot.membershipSourceUrl, 'ssga.com')
    || !currentPublication(snapshot.membershipAsOf) || !currentPublication(snapshot.asOf)
    || !recent(snapshot.fetchedAt, nowMs)
    || !Array.isArray(snapshot.rows) || snapshot.rows.length !== 10
    || !verifiedRows(snapshot.rows, nowMs, { ranked: true })) {
    return result('unavailable', date, 'top10_unverified');
  }
  const top10Tickers = snapshot.rows.map(row => row.ticker);
  if (snapshot.momoStatus === 'unavailable') {
    return result('unavailable', date, 'momo_report_unavailable', top10Tickers);
  }
  const publication = normalizeMomoTrackerSnapshot(snapshot.momoSnapshot, nowMs);
  if (publication.status !== 'available' || snapshot.momoPublicationDate !== date) {
    const pending = snapshot.momoStatus === 'pending' && !snapshot.momoSnapshot
      && snapshot.momoPublicationDate == null
      && Array.isArray(snapshot.supplementalRows) && snapshot.supplementalRows.length === 0;
    return result(pending ? 'pending' : 'unavailable', date,
      pending ? 'awaiting_current_momo_report' : 'momo_report_unverified', top10Tickers);
  }
  const includedCompanies = new Set(top10Tickers.map(canonicalMomoCompanyTicker));
  const expectedExtras = new Set();
  for (const row of publication.rows) {
    const companyTicker = canonicalMomoCompanyTicker(row.ticker);
    if (includedCompanies.has(companyTicker) || MOMO_EXCLUDED_TICKERS.includes(row.ticker)) continue;
    includedCompanies.add(companyTicker);
    expectedExtras.add(row.ticker);
  }
  if (!Array.isArray(snapshot.supplementalRows)
    || snapshot.supplementalRows.length !== expectedExtras.size
    || !snapshot.supplementalRows.every(row => expectedExtras.has(row?.ticker))) {
    return result('unavailable', date, 'momo_additions_mismatch', top10Tickers);
  }
  if (!verifiedRows(snapshot.supplementalRows, nowMs)) {
    return result('unavailable', date, 'momo_additions_unverified', top10Tickers);
  }
  return result('ready', date, null, top10Tickers, snapshot.supplementalRows.map(row => row.ticker));
}

module.exports = { validateMomoRoster, rosterCheckResult: result };
