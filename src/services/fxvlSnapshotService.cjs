const {
  addCalendarDays,
  computeVolatilityMetrics,
  mostRecentCompletedTradingDateKey,
  previousTradingDateKey,
} = require('./volatilitySnapshotService.cjs');

const DEFAULT_TOKEN_URL = 'https://auth.cmegroup.com/as/token.oauth2';
const DEFAULT_BASE_URL = 'https://markets.api.cmegroup.com/cvol-eod/v1';
const FXVL_PRODUCT_CODE = 'FXVL';
const TOKEN_REFRESH_SKEW_MS = 60 * 1000;
const DEFAULT_HISTORY_LOOKBACK_DAYS = 400;
const DEFAULT_MAX_STALE_DAYS = 5;
const DEFAULT_APP_NAME = 'market-dashboard';
const DEFAULT_APP_VENDOR = 'timavn';
const DEFAULT_APP_VERSION = '1.0.0';

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizeDateKey(raw) {
  const value = String(raw || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  return `${match[3]}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`;
}

function readCredentials(env = process.env) {
  const apiId = String(env.CME_CVOL_API_ID || '').trim();
  const apiPassword = String(env.CME_CVOL_API_PASSWORD || '').trim();
  if (!apiId || !apiPassword) return null;
  return {
    apiId,
    apiPassword,
    tokenUrl: String(env.CME_CVOL_TOKEN_URL || DEFAULT_TOKEN_URL).trim() || DEFAULT_TOKEN_URL,
    baseUrl: String(env.CME_CVOL_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/$/, '') || DEFAULT_BASE_URL,
    appName: String(env.CME_CVOL_APP_NAME || DEFAULT_APP_NAME).trim() || DEFAULT_APP_NAME,
    appVendor: String(env.CME_CVOL_APP_VENDOR || DEFAULT_APP_VENDOR).trim() || DEFAULT_APP_VENDOR,
    appVersion: String(env.CME_CVOL_APP_VERSION || DEFAULT_APP_VERSION).trim() || DEFAULT_APP_VERSION,
  };
}

function extractInstrumentEntries(payload) {
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload)) {
    return payload.flatMap((entry) => extractInstrumentEntries(entry));
  }
  if (Array.isArray(payload.instrument)) {
    return payload.instrument.map((instrument) => ({
      businessDt: payload.businessDt,
      productCode: instrument?.productCode,
      values: instrument?.values,
    }));
  }
  if (Array.isArray(payload.instruments)) {
    return payload.instruments.map((instrument) => ({
      businessDt: payload.businessDt || instrument?.businessDt,
      productCode: instrument?.productCode,
      values: instrument?.values,
    }));
  }
  if (payload.productCode || payload.cvolIndex != null || payload.values) {
    return [{
      businessDt: payload.businessDt || payload.date,
      productCode: payload.productCode,
      values: payload.values || [payload],
    }];
  }
  if (Array.isArray(payload.data)) {
    return payload.data.flatMap((entry) => extractInstrumentEntries(entry));
  }
  return [];
}

function pickCvolIndex(values) {
  const list = Array.isArray(values) ? values : (values ? [values] : []);
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const level = finitePositive(
      entry.cvolIndex
      ?? entry.cvol
      ?? entry.CVOLIndex
      ?? entry.index,
    );
    if (level != null) return level;
  }
  return null;
}

function parseFxvlHistoryRows(payload, productCode = FXVL_PRODUCT_CODE) {
  const wanted = String(productCode || FXVL_PRODUCT_CODE).trim().toUpperCase();
  const byDate = new Map();
  extractInstrumentEntries(payload).forEach((entry) => {
    const code = String(entry?.productCode || wanted).trim().toUpperCase();
    if (code && code !== wanted) return;
    const date = normalizeDateKey(entry?.businessDt);
    const close = pickCvolIndex(entry?.values);
    if (date && close != null) byDate.set(date, { date, close });
  });
  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function tradingSessionsBetween(startDateKey, endDateKey) {
  if (!startDateKey || !endDateKey || startDateKey > endDateKey) return Number.POSITIVE_INFINITY;
  let sessions = 0;
  let probe = endDateKey;
  while (probe > startDateKey) {
    probe = previousTradingDateKey(probe);
    sessions += 1;
    if (sessions > 366) break;
  }
  return sessions;
}

function isHistoryFreshEnough(asOfDateKey, now, maxStaleDays) {
  if (!asOfDateKey) return false;
  const expected = mostRecentCompletedTradingDateKey(now);
  if (asOfDateKey === expected) return true;
  if (asOfDateKey > expected) return false;
  return tradingSessionsBetween(asOfDateKey, expected) <= maxStaleDays;
}

function buildHistoricalFxvlSnapshot(rows, {
  asOfDateKey,
  now,
  source = 'cme',
  sourceLabel = 'CME Group CVOL',
  measure = 'cvol',
} = {}) {
  const metrics = computeVolatilityMetrics(rows);
  if (!metrics) return null;
  const requiredNumeric = [
    'lastPx',
    'day1Ago',
    'day15Ago',
    'week4Ago',
    'month3Ago',
    'month6Ago',
    'dayChangePct',
    'fifteenDayChangePct',
    'monthChangePct',
    'threeMonthChangePct',
    'sixMonthChangePct',
  ];
  if (requiredNumeric.some((key) => !Number.isFinite(metrics[key]))) {
    return null;
  }

  const asOf = new Date(`${asOfDateKey}T21:00:00.000Z`);
  if (Number.isNaN(asOf.getTime())) return null;

  return {
    ...metrics,
    source,
    sourceLabel,
    measure,
    quoteMode: 'end-of-day',
    asOf: asOf.toISOString(),
    availability: 'historical',
    freshness: 'historical',
    generatedAt: now.toISOString(),
  };
}

const G5_FX_PAIR_SYMBOLS = Object.freeze([
  'EURUSD',
  'GBPUSD',
  'USDJPY',
  'AUDUSD',
  'USDCAD',
]);
const REALIZED_VOL_WINDOW = 21;
const TRADING_DAYS_PER_YEAR = 252;

function normalizeHistoryRows(rows) {
  const byDate = new Map();
  (rows || []).forEach((row) => {
    let date = normalizeDateKey(row?.date);
    if (!date && row?.t != null) {
      const parsed = new Date(row.t);
      if (!Number.isNaN(parsed.getTime())) date = parsed.toISOString().slice(0, 10);
    }
    const close = finitePositive(row?.close);
    if (date && close != null) byDate.set(date, { date, close });
  });
  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function buildPairRealizedVolSeries(historyRows, window = REALIZED_VOL_WINDOW) {
  const rows = normalizeHistoryRows(historyRows);
  if (rows.length <= window) return [];
  const out = [];
  for (let index = window; index < rows.length; index += 1) {
    const logReturns = [];
    for (let offset = index - window + 1; offset <= index; offset += 1) {
      const prior = rows[offset - 1]?.close;
      const current = rows[offset]?.close;
      if (!Number.isFinite(prior) || !Number.isFinite(current) || prior <= 0 || current <= 0) {
        logReturns.length = 0;
        break;
      }
      logReturns.push(Math.log(current / prior));
    }
    if (logReturns.length !== window) continue;
    const mean = logReturns.reduce((sum, value) => sum + value, 0) / logReturns.length;
    const variance = logReturns.reduce((sum, value) => sum + ((value - mean) ** 2), 0)
      / (logReturns.length - 1);
    if (!(variance > 0)) continue;
    const annualized = Math.sqrt(variance * TRADING_DAYS_PER_YEAR) * 100;
    if (!Number.isFinite(annualized) || annualized <= 0) continue;
    out.push({ date: rows[index].date, close: Number(annualized.toFixed(4)) });
  }
  return out;
}

function buildG5RealizedVolSeries(pairHistoriesBySymbol, window = REALIZED_VOL_WINDOW) {
  const seriesBySymbol = G5_FX_PAIR_SYMBOLS.map((symbol) => (
    buildPairRealizedVolSeries(pairHistoriesBySymbol?.[symbol], window)
  ));
  if (seriesBySymbol.some((series) => series.length === 0)) return [];

  const dateSets = seriesBySymbol.map((series) => new Set(series.map((row) => row.date)));
  const sharedDates = [...dateSets[0]]
    .filter((date) => dateSets.every((set) => set.has(date)))
    .sort((left, right) => left.localeCompare(right));

  return sharedDates.map((date) => {
    const levels = seriesBySymbol.map((series) => series.find((row) => row.date === date)?.close);
    if (levels.some((level) => !Number.isFinite(level))) return null;
    const average = levels.reduce((sum, level) => sum + level, 0) / levels.length;
    return { date, close: Number(average.toFixed(4)) };
  }).filter(Boolean);
}

function createFxvlSnapshotService({
  httpClient = null,
  env = process.env,
  now = () => new Date(),
  logger = console,
  maxStaleDays = DEFAULT_MAX_STALE_DAYS,
  historyLookbackDays = DEFAULT_HISTORY_LOOKBACK_DAYS,
  credentials = undefined,
  fetchPairHistory = null,
} = {}) {
  const client = httpClient || require('axios');
  const resolvedCredentials = credentials === undefined ? readCredentials(env) : credentials;
  let tokenCache = null;
  let tokenInFlight = null;

  function applicationHeaders() {
    if (!resolvedCredentials) return {};
    return {
      'CME-Application-Name': resolvedCredentials.appName,
      'CME-Application-Vendor': resolvedCredentials.appVendor,
      'CME-Application-Version': resolvedCredentials.appVersion,
    };
  }

  async function getAccessToken() {
    if (!resolvedCredentials) return null;
    const currentTime = now().getTime();
    if (tokenCache && tokenCache.expiresAt > currentTime + TOKEN_REFRESH_SKEW_MS) {
      return tokenCache.accessToken;
    }
    if (tokenInFlight) return tokenInFlight;

    tokenInFlight = (async () => {
      const basic = Buffer
        .from(`${resolvedCredentials.apiId}:${resolvedCredentials.apiPassword}`, 'utf8')
        .toString('base64');
      const response = await client.post(
        resolvedCredentials.tokenUrl,
        'grant_type=client_credentials',
        {
          timeout: 12000,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${basic}`,
          },
        },
      );
      const accessToken = String(response?.data?.access_token || '').trim();
      const expiresInSec = Number(response?.data?.expires_in);
      if (!accessToken) {
        throw new Error('CME OAuth response missing access_token');
      }
      const ttlMs = Number.isFinite(expiresInSec) && expiresInSec > 0
        ? expiresInSec * 1000
        : 5 * 60 * 1000;
      tokenCache = {
        accessToken,
        expiresAt: now().getTime() + ttlMs,
      };
      return accessToken;
    })().finally(() => {
      tokenInFlight = null;
    });

    return tokenInFlight;
  }

  async function authorizedGet(path, params) {
    const accessToken = await getAccessToken();
    const response = await client.get(`${resolvedCredentials.baseUrl}${path}`, {
      timeout: 15000,
      params,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...applicationHeaders(),
      },
    });
    return response.data;
  }

  async function getCmeSnapshot() {
    if (!resolvedCredentials) return null;
    const requestTime = now();
    const expectedDate = mostRecentCompletedTradingDateKey(requestTime);
    const startDt = addCalendarDays(expectedDate, -Math.max(180, historyLookbackDays));

    const [latestPayload, historyPayload] = await Promise.all([
      authorizedGet('/latest', { productCodes: FXVL_PRODUCT_CODE }),
      authorizedGet('/history', { productCodes: FXVL_PRODUCT_CODE, startDt }),
    ]);

    const historyRows = parseFxvlHistoryRows(historyPayload);
    const latestRows = parseFxvlHistoryRows(latestPayload);
    const latest = latestRows.at(-1) || null;
    const mergedByDate = new Map(historyRows.map((row) => [row.date, row]));
    if (latest) mergedByDate.set(latest.date, latest);
    const merged = [...mergedByDate.values()].sort((left, right) => left.date.localeCompare(right.date));
    if (merged.length < 130) {
      throw new Error('incomplete CME FXVL history');
    }

    const asOfDateKey = merged.at(-1).date;
    if (!isHistoryFreshEnough(asOfDateKey, requestTime, maxStaleDays)) {
      throw new Error(`stale CME FXVL asOf=${asOfDateKey}`);
    }

    const snapshot = buildHistoricalFxvlSnapshot(merged, {
      asOfDateKey,
      now: requestTime,
      source: 'cme',
      sourceLabel: 'CME Group CVOL',
      measure: 'cvol',
    });
    if (!snapshot) throw new Error('unable to build complete CME FXVL metrics');
    return snapshot;
  }

  async function getYahooG5Snapshot() {
    if (typeof fetchPairHistory !== 'function') return null;
    const requestTime = now();
    const expectedDate = mostRecentCompletedTradingDateKey(requestTime);
    const pairEntries = await Promise.all(G5_FX_PAIR_SYMBOLS.map(async (symbol) => {
      const history = await fetchPairHistory(symbol);
      return [symbol, history];
    }));
    const pairHistories = Object.fromEntries(pairEntries);
    const missing = G5_FX_PAIR_SYMBOLS.filter((symbol) => normalizeHistoryRows(pairHistories[symbol]).length < 150);
    if (missing.length > 0) {
      throw new Error(`incomplete Yahoo G5 FX history for ${missing.join(',')}`);
    }

    const mergedRaw = buildG5RealizedVolSeries(pairHistories);
    const merged = mergedRaw.filter((row) => row.date <= expectedDate);
    if (merged.length < 130) {
      throw new Error('incomplete Yahoo G5 realized-vol series');
    }

    const asOfDateKey = merged.at(-1).date;
    if (!isHistoryFreshEnough(asOfDateKey, requestTime, maxStaleDays)) {
      throw new Error(`stale Yahoo G5 FX vol asOf=${asOfDateKey}`);
    }

    const snapshot = buildHistoricalFxvlSnapshot(merged, {
      asOfDateKey,
      now: requestTime,
      source: 'yahoo',
      sourceLabel: 'Yahoo G5 FX 1M realized vol',
      measure: 'realized',
    });
    if (!snapshot) throw new Error('unable to build complete Yahoo G5 FX vol metrics');
    return snapshot;
  }

  async function getSnapshot() {
    if (resolvedCredentials) {
      try {
        return await getCmeSnapshot();
      } catch (error) {
        logger.warn?.(`[fxvl-snapshot] CME unavailable, trying Yahoo G5 fallback: ${error.message}`);
      }
    }

    if (typeof fetchPairHistory !== 'function') {
      if (!resolvedCredentials) return null;
      return null;
    }

    try {
      return await getYahooG5Snapshot();
    } catch (error) {
      logger.warn?.(`[fxvl-snapshot] Yahoo G5 fallback unavailable: ${error.message}`);
      return null;
    }
  }

  return {
    getSnapshot,
    hasCredentials: Boolean(resolvedCredentials),
    supportsYahooFallback: typeof fetchPairHistory === 'function',
  };
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_TOKEN_URL,
  FXVL_PRODUCT_CODE,
  G5_FX_PAIR_SYMBOLS,
  REALIZED_VOL_WINDOW,
  buildG5RealizedVolSeries,
  buildHistoricalFxvlSnapshot,
  buildPairRealizedVolSeries,
  createFxvlSnapshotService,
  extractInstrumentEntries,
  isHistoryFreshEnough,
  normalizeHistoryRows,
  parseFxvlHistoryRows,
  pickCvolIndex,
  readCredentials,
};
