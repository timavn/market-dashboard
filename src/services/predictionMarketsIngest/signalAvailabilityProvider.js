const DynamoDB = require('aws-sdk/clients/dynamodb');

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MONTHS = Object.freeze({
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
});
const MONTH_NAMES = Object.freeze({
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
});

const defaultDynamodb = new DynamoDB.DocumentClient();
const cache = new Map();

function dateKeyInNewYork(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return values.year && values.month && values.day
    ? `${values.year}-${values.month}-${values.day}`
    : null;
}

function cpiMonthFromEvent(event = {}) {
  const ticker = String(event.ticker || event.eventTicker || '').toUpperCase();
  const match = ticker.match(/-(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(?:-|$)/);
  if (!match) return null;
  return `20${match[1]}-${String(MONTHS[match[2]]).padStart(2, '0')}`;
}

function cpiMonthFromSnapshot(snapshot = {}) {
  const label = String(snapshot?.data?.forecastMonth || snapshot?.forecastMonth || '').trim().toLowerCase();
  const match = label.match(/^(january|february|march|april|may|june|july|august|september|october|november|december)\s+(20\d{2})$/);
  if (!match) return null;
  return `${match[2]}-${String(MONTH_NAMES[match[1]]).padStart(2, '0')}`;
}

function finiteRange(item) {
  const lrr = Number(item?.lrr);
  const hrr = Number(item?.hrr);
  return Number.isFinite(lrr) && Number.isFinite(hrr) && lrr < hrr;
}

async function cachedLoad(key, loader, { now = Date.now(), ttlMs = DEFAULT_TTL_MS, useCache = true } = {}) {
  const current = cache.get(key);
  if (useCache && current && current.expiresAt > now) return current.value;
  const value = await loader();
  if (useCache) cache.set(key, { value, expiresAt: now + ttlMs });
  return value;
}

async function loadExactRiskRange(dynamodb, ticker, date, options) {
  if (!ticker || !date) return null;
  return cachedLoad(`risk:${ticker}:${date}`, async () => {
    const result = await dynamodb.get({
      TableName: 'RiskRangeData',
      Key: { ticker, date },
    }).promise();
    return result.Item || null;
  }, options);
}

function recentDateKeys(now, count = 21) {
  return Array.from({ length: count }, (_, index) => (
    dateKeyInNewYork(new Date(now - index * 24 * 60 * 60 * 1000))
  )).filter(Boolean);
}

async function loadLatestCpiSnapshot(dynamodb = defaultDynamodb, options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  return cachedLoad('cpi:inflation-nowcast', async () => {
    const keys = recentDateKeys(now).map((date) => ({ date, snapshotType: 'inflation-nowcast' }));
    const result = await dynamodb.batchGet({
      RequestItems: {
        HedgeyeDailySnapshot: { Keys: keys },
      },
    }).promise();
    return (result.Responses?.HedgeyeDailySnapshot || [])
      .sort((left, right) => String(right.date || '').localeCompare(String(left.date || '')))[0] || null;
  }, options);
}

function unavailable(name, reason, details = {}) {
  return { name, status: 'unavailable', reason, ...details };
}

async function getOverviewSignalAvailability(context = {}, options = {}) {
  const dynamodb = options.dynamodb || defaultDynamodb;
  const market = String(context.market || '').toLowerCase();
  try {
    if (market === 'cpi') {
      const requiredMonth = cpiMonthFromEvent(context.event);
      const snapshot = await loadLatestCpiSnapshot(dynamodb, {
        ...options,
        useCache: options.useCache !== false && !options.dynamodb,
      });
      const sourceMonth = cpiMonthFromSnapshot(snapshot);
      if (!snapshot || !requiredMonth || sourceMonth !== requiredMonth) {
        return unavailable('Hedgeye Inflation Nowcast', 'No source-matched CPI nowcast is available.', {
          requiredMonth,
          sourceMonth,
          asOf: snapshot?.publishedAt || snapshot?.scrapedAt || snapshot?.date || null,
          source: snapshot?.sourceProduct || 'HedgeyeDailySnapshot',
        });
      }
      return {
        name: 'Hedgeye Inflation Nowcast',
        status: 'available',
        requiredMonth,
        sourceMonth,
        asOf: snapshot.publishedAt || snapshot.scrapedAt || snapshot.date || null,
        source: snapshot.sourceProduct || 'HedgeyeDailySnapshot',
      };
    }

    const ticker = market === 'spx' ? 'SPX' : market === 'wti' ? 'WTIC' : null;
    const name = ticker === 'SPX' ? 'SPX Risk Range' : 'WTIC Risk Range';
    const requiredDate = dateKeyInNewYork(
      context.event?.observationTime || context.event?.strikeDate || context.event?.closeTime,
    );
    const range = await loadExactRiskRange(dynamodb, ticker, requiredDate, {
      ...options,
      useCache: options.useCache !== false && !options.dynamodb,
    });
    if (!finiteRange(range)) {
      return unavailable(name, `No exact-date ${ticker || 'Risk Range'} data is available.`, {
        requiredDate,
        asOf: range?.date || null,
        source: 'RiskRangeData',
      });
    }
    return {
      name,
      status: 'available',
      requiredDate,
      asOf: range.date,
      source: 'RiskRangeData',
    };
  } catch (error) {
    const name = market === 'cpi'
      ? 'Hedgeye Inflation Nowcast'
      : market === 'spx' ? 'SPX Risk Range' : 'WTIC Risk Range';
    return unavailable(name, error.message || 'Signal availability could not be verified.');
  }
}

module.exports = {
  cpiMonthFromEvent,
  cpiMonthFromSnapshot,
  dateKeyInNewYork,
  finiteRange,
  getOverviewSignalAvailability,
  loadLatestCpiSnapshot,
};
