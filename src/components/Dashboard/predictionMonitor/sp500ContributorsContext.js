import { isTradingDateKey, previousTradingDateKey } from '../../../utils/usEquityMarketCalendar.cjs';
import { MOMO_EXCLUDED_TICKERS, canonicalMomoCompanyTicker } from '../../../constants/momoTrackerCatalog.cjs';
import { newYorkDateKey, normalizeMomoTrackerSnapshot } from './momoTrackerContext';

const numeric = (value) => ['number', 'string'].includes(typeof value)
  && String(value).trim() !== '' && Number.isFinite(Number(value));
const blocked = (value) => !value || [
  'mock', 'isMock', 'seeded', 'seed', 'isSeed', 'stale', 'isStale', 'cacheOnly', 'isCacheOnly', 'fromCache', 'fallback', 'isFallback',
  'offline', 'disconnected', 'refreshFailed', 'synthetic', 'inferred', 'modelOnly', 'portfolioDerived', 'costBasisDerived',
].some((key) => value[key] === true)
  || value.connected === false || value.available === false
  || /mock|seed|stale|cache|fallback|offline|disconnected|failed|synthetic|inferred|model.only|portfolio|cost.basis/i.test(
    [value.status, value.warning, value.error, value.freshness, value.provenance].filter(Boolean).join(' '),
  );
const recent = (value, nowMs, maxAgeMs) => {
  const age = nowMs - Date.parse(value || '');
  return Number.isFinite(age) && age >= -5_000 && age <= maxAgeMs;
};
const sourceUrl = (value, host) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch { return false; }
};
const minuteInNewYork = (nowMs) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(nowMs));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Number(values.hour) * 60 + Number(values.minute);
};

export const isSp500RegularSession = (nowMs = Date.now()) => isTradingDateKey(newYorkDateKey(nowMs))
  && minuteInNewYork(nowMs) >= 570 && minuteInNewYork(nowMs) < 960;

export function currentSp500ContributorQuote(quote, nowMs = Date.now()) {
  if (blocked(quote) || quote.source !== 'Nasdaq' || !sourceUrl(quote.sourceUrl, 'nasdaq.com')
    || !numeric(quote.price) || Number(quote.price) <= 0
    || !['live', 'delayed', 'last-close'].includes(quote.status)) return null;
  const today = newYorkDateKey(nowMs);
  const observed = Date.parse(quote.asOf || '');
  if (!Number.isFinite(observed) || observed > nowMs + 5_000
    || newYorkDateKey(observed) !== quote.marketDate || !isTradingDateKey(quote.marketDate)) return null;
  const isTradingDay = isTradingDateKey(today);
  const minute = minuteInNewYork(nowMs);
  if (quote.status === 'last-close') {
    const allowedDate = quote.marketDate === today
      // A provider-designated official close can be 1pm on a shortened session.
      ? minuteInNewYork(observed) >= 13 * 60
      : quote.marketDate === previousTradingDateKey(today) && (!isTradingDay || minute < 570);
    if (!allowedDate) return null;
  } else if (!isTradingDay || minute < 570 || minute >= 960 || quote.marketDate !== today
    || !recent(quote.asOf, nowMs, quote.status === 'live' ? 60_000 : 20 * 60_000)) return null;
  return { ...quote, price: Number(quote.price), changePercent: numeric(quote.changePercent) ? Number(quote.changePercent) : null };
}

function currentMarketCap(cap, nowMs) {
  if (blocked(cap) || cap.status !== 'available' || cap.source !== 'Nasdaq'
    || !sourceUrl(cap.sourceUrl, 'nasdaq.com') || cap.currency !== 'USD'
    || !numeric(cap.value) || Number(cap.value) <= 0
    || !recent(cap.fetchedAt || cap.asOf, nowMs, 20 * 60_000)) return null;
  return { ...cap, value: Number(cap.value) };
}

export function supplementalMomoRows(momoRows = [], contributorRows = []) {
  const included = new Set(contributorRows.map((row) => canonicalMomoCompanyTicker(row.ticker)));
  return momoRows.filter((row) => {
    const company = canonicalMomoCompanyTicker(row.ticker);
    if (MOMO_EXCLUDED_TICKERS.includes(row.ticker) || included.has(company)) return false;
    included.add(company);
    return true;
  });
}

export function currentSp500Contributors(snapshot, nowMs = Date.now()) {
  const today = newYorkDateKey(nowMs);
  if (blocked(snapshot) || snapshot.status !== 'available'
    || !String(snapshot.source || '').includes('State Street')
    || !sourceUrl(snapshot.sourceUrl, 'ssga.com')
    || !recent(snapshot.fetchedAt, nowMs, 20 * 60_000)
    || ![today, previousTradingDateKey(today)].includes(snapshot.asOf)
    || !isTradingDateKey(snapshot.asOf)
    || !Array.isArray(snapshot.rows) || snapshot.rows.length !== 10) return null;
  if (snapshot.rows.some((row) => blocked(row) || !/^[A-Z][A-Z0-9.-]{0,9}$/.test(row.ticker)
    || MOMO_EXCLUDED_TICKERS.includes(row.ticker)
    || (row.weightPct != null && (!numeric(row.weightPct) || Number(row.weightPct) <= 0 || Number(row.weightPct) >= 100)))
    || new Set(snapshot.rows.map((row) => canonicalMomoCompanyTicker(row.ticker))).size !== 10
    || snapshot.rows.reduce((sum, row) => sum + Number(row.weightPct), 0) > 100) return null;
  const publication = normalizeMomoTrackerSnapshot(snapshot.momoSnapshot, nowMs);
  const supplementalTickers = publication.status === 'available'
    && snapshot.momoPublicationDate === publication.publicationDate
    ? supplementalMomoRows(publication.rows, snapshot.rows).map((row) => row.ticker) : [];
  return {
    ...snapshot,
    supplementalRows: supplementalTickers.flatMap((ticker) => {
      const matches = Array.isArray(snapshot.supplementalRows)
        ? snapshot.supplementalRows.filter((row) => row?.ticker === ticker) : [];
      if (matches.length !== 1 || blocked(matches[0]) || MOMO_EXCLUDED_TICKERS.includes(ticker)
        || snapshot.rows.some((row) => row.ticker === ticker)) return [];
      return [{
        ticker, name: matches[0].name || ticker,
        marketCap: currentMarketCap(matches[0].marketCap, nowMs),
        quote: currentSp500ContributorQuote(matches[0].quote, nowMs),
      }];
    }).sort((a, b) => (b.marketCap?.value ?? 0) - (a.marketCap?.value ?? 0)
      || a.ticker.localeCompare(b.ticker)),
    rows: snapshot.rows
      .map((row) => ({
        ...row, weightPct: numeric(row.weightPct) ? Number(row.weightPct) : null,
        marketCap: currentMarketCap(row.marketCap, nowMs),
        quote: currentSp500ContributorQuote(row.quote, nowMs),
      }))
      .sort((a, b) => (b.marketCap?.value ?? 0) - (a.marketCap?.value ?? 0)
        || (b.weightPct ?? 0) - (a.weightPct ?? 0) || a.ticker.localeCompare(b.ticker))
      .map((row, index) => ({ ...row, rank: index + 1 })),
  };
}
