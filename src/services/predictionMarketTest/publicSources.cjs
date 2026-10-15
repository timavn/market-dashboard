const { setImmediate: yieldEventLoop } = require('node:timers/promises');
const { zonedTimeToUtc } = require('date-fns-tz');
const { isOfficialFesTermsUrl, parseFesResolverIdentity } = require('../forecastExFesIdentity.cjs');
const { parseRgdpContractIdentity } = require('../forecastExRgdpIdentity.cjs');

const KALSHI_PUBLIC_BASE_URL = 'https://api.elections.kalshi.com/trade-api/v2';
const FORECASTEX_BASE_URL = 'https://www.forecastex.com/api';
const BLS_RELEASE_URL = 'https://www.bls.gov/news.release/cpi.nr0.htm';
const BLS_RSS_URL = 'https://www.bls.gov/feed/cpi.rss';
const BLS_API_URL = 'https://api.bls.gov/publicAPI/v2/timeseries/data/';
const COINBASE_BASE_URL = 'https://api.exchange.coinbase.com';
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 12_000;

function sourceError(message, code) {
  return Object.assign(new Error(message), { code });
}

function finiteNumber(value, { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY } = {}) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function isoTimestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function forecastExTimestamp(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const hasExplicitZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  try {
    const date = hasExplicitZone
      ? new Date(raw)
      : zonedTimeToUtc(raw.replace(' ', 'T'), 'America/Chicago');
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  } catch (_) {
    return null;
  }
}

function normalizeKalshiPrice(market, field) {
  const dollars = finiteNumber(market?.[`${field}_dollars`], { min: 0, max: 1 });
  if (dollars != null) return dollars;
  const legacy = finiteNumber(market?.[field], { min: 0, max: 100 });
  if (legacy == null) return null;
  return legacy > 1 ? legacy / 100 : legacy;
}

function normalizeKalshiEvent(payload, { eventTicker, fetchedAt = new Date().toISOString() } = {}) {
  const event = payload?.event;
  if (!event || !Array.isArray(event.markets)) {
    throw sourceError('Kalshi returned an invalid event response.', 'PM_TEST_KALSHI_SCHEMA_INVALID');
  }
  const actualTicker = String(event.event_ticker || eventTicker || '').trim().toUpperCase();
  if (!actualTicker || (eventTicker && actualTicker !== String(eventTicker).toUpperCase())) {
    throw sourceError('Kalshi returned the wrong event.', 'PM_TEST_KALSHI_IDENTITY_INVALID');
  }
  const lines = event.markets.map((market) => {
    const ticker = String(market?.ticker || '').trim();
    const strikeType = String(market?.strike_type || 'greater').trim().toLowerCase();
    const lowerBound = finiteNumber(market?.floor_strike);
    const upperBound = finiteNumber(market?.cap_strike);
    if (!ticker || !['greater', 'less', 'between'].includes(strikeType)
      || (strikeType === 'greater' && lowerBound == null)
      || (strikeType === 'less' && upperBound == null)
      || (strikeType === 'between' && (lowerBound == null || upperBound == null || lowerBound > upperBound))) {
      throw sourceError('Kalshi returned a market without a valid condition.', 'PM_TEST_KALSHI_SCHEMA_INVALID');
    }
    const strike = lowerBound ?? upperBound;
    return {
      venue: 'Kalshi',
      ticker,
      strike,
      strikeType,
      comparator: strikeType === 'greater' ? '>' : strikeType === 'less' ? '<' : 'inclusive_range',
      lowerBound,
      upperBound,
      conditionLabel: String(market.subtitle || '').trim() || null,
      status: String(market.status || '').toLowerCase() || 'unknown',
      closeAt: isoTimestamp(market.close_time),
      yesBid: normalizeKalshiPrice(market, 'yes_bid'),
      yesAsk: normalizeKalshiPrice(market, 'yes_ask'),
      noBid: normalizeKalshiPrice(market, 'no_bid'),
      noAsk: normalizeKalshiPrice(market, 'no_ask'),
      lastTrade: normalizeKalshiPrice(market, 'last_price'),
      yesBidSize: finiteNumber(market.yes_bid_size_fp, { min: 0 }),
      yesAskSize: finiteNumber(market.yes_ask_size_fp, { min: 0 }),
      volume24h: finiteNumber(market.volume_24h_fp, { min: 0 }),
      openInterest: finiteNumber(market.open_interest_fp, { min: 0 }),
      priceType: 'executable_bid_ask',
      fetchedAt,
      sourceTimestamp: fetchedAt,
      result: String(market.result || '').trim().toLowerCase() || null,
      expirationValue: finiteNumber(market.expiration_value),
      customStrike: market.custom_strike && typeof market.custom_strike === 'object'
        ? {
          frontMonthContract: market.custom_strike.front_month_contract || null,
          strikeDate: isoTimestamp(market.custom_strike.strike_date),
        }
        : null,
    };
  }).sort((left, right) => left.strike - right.strike);
  const settlementValues = [...new Set(lines.map((line) => line.expirationValue).filter((value) => value != null))];
  return {
    provider: 'kalshi_public_api',
    venue: 'Kalshi',
    eventTicker: actualTicker,
    title: event.title || null,
    fetchedAt,
    lines,
    settlementValue: settlementValues.length === 1 ? settlementValues[0] : null,
    settlementConflict: settlementValues.length > 1,
  };
}

function normalizeCoinbaseTicker(payload, { productId, fetchedAt = new Date().toISOString() } = {}) {
  const expected = String(productId || '').trim().toUpperCase();
  if (!/^(?:BTC|ETH)-USD$/.test(expected)) {
    throw sourceError('Coinbase product id is not registered.', 'PM_TEST_COINBASE_IDENTITY_INVALID');
  }
  const price = finiteNumber(payload?.price, { min: 0 });
  const bid = finiteNumber(payload?.bid, { min: 0 });
  const ask = finiteNumber(payload?.ask, { min: 0 });
  const sourceTime = isoTimestamp(payload?.time);
  if (price == null || bid == null || ask == null || bid > ask || !sourceTime) {
    throw sourceError('Coinbase returned an invalid ticker.', 'PM_TEST_COINBASE_SCHEMA_INVALID');
  }
  return {
    provider: 'coinbase_exchange_public',
    productId: expected,
    price,
    bid,
    ask,
    sourceTimestamp: sourceTime,
    fetchedAt,
  };
}

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      values.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  if (quoted) throw sourceError('CSV contains an unterminated quoted field.', 'PM_TEST_CSV_INVALID');
  values.push(current);
  return values.map((value) => value.trim());
}

function parseForecastExContractsResponse(payload, { productId } = {}) {
  if (!productId) throw sourceError('ForecastEx product id is required.', 'PM_TEST_FORECASTEX_PRODUCT_REQUIRED');
  if (Number(payload?.statusCode) !== 200 || !payload?.body || typeof payload.body.data !== 'string') {
    throw sourceError('ForecastEx contract response schema changed.', 'PM_TEST_FORECASTEX_SCHEMA_INVALID');
  }
  let rows;
  try {
    rows = JSON.parse(payload.body.data);
  } catch (_) {
    throw sourceError('ForecastEx contract data was not valid nested JSON.', 'PM_TEST_FORECASTEX_SCHEMA_INVALID');
  }
  if (!Array.isArray(rows)) throw sourceError('ForecastEx contract data was not an array.', 'PM_TEST_FORECASTEX_SCHEMA_INVALID');
  return rows.map((row) => {
    const contractId = String(row?.contract_id || '').trim();
    if (!contractId.startsWith(`${productId}_`) || String(row.product_id || '') !== productId) {
      throw sourceError('ForecastEx returned a contract outside the requested product.', 'PM_TEST_FORECASTEX_IDENTITY_INVALID');
    }
    const strike = finiteNumber(contractId.slice(contractId.lastIndexOf('_') + 1));
    if (strike == null) throw sourceError('ForecastEx contract strike was invalid.', 'PM_TEST_FORECASTEX_SCHEMA_INVALID');
    const contractDate = contractId.match(/^[A-Z0-9]+_(\d{2})(\d{2})(\d{2})_/)?.slice(1);
    const eventDate = contractDate ? `20${contractDate[2]}-${contractDate[0]}-${contractDate[1]}` : null;
    let resolverIdentity = {};
    if (productId === 'FES') {
      try {
        resolverIdentity = parseFesResolverIdentity(row.question, { eventDate, strike });
      } catch (error) {
        throw sourceError(error.message, error.code || 'PM_TEST_FORECASTEX_IDENTITY_INVALID');
      }
      if (!isOfficialFesTermsUrl(row.exchange_spec_url)) {
        throw sourceError('ForecastEx FES terms were missing or not authoritative.', 'PM_TEST_FORECASTEX_IDENTITY_INVALID');
      }
    }
    if (productId === 'RGDP') {
      resolverIdentity = parseRgdpContractIdentity({
        contractId, productId, strike, question: row.question, rulesUrl: row.exchange_spec_url,
      });
    }
    return {
      venue: 'ForecastEx',
      contractId,
      productId,
      strike,
      comparator: '>',
      question: row.question || null,
      eventDisplayName: row.event_display_name || null,
      expirationDate: forecastExTimestamp(row.expiration_date),
      lastTradeDate: forecastExTimestamp(row.last_trade_date),
      payoutDate: forecastExTimestamp(row.payout_date),
      openInterest: finiteNumber(row.open_interest, { min: 0 }),
      ...(productId === 'RGDP' ? { volume: finiteNumber(row.volume, { min: 0 }) } : {}),
      rulesUrl: row.exchange_spec_url || null,
      ...resolverIdentity,
    };
  }).sort((left, right) => left.strike - right.strike);
}

const FORECASTEX_PAIR_COLUMNS = Object.freeze([
  'pair_id',
  'event_contract',
  'expiration_date',
  'quantity',
  'yes_price',
  'no_price',
  'pair_time',
]);

const FORECASTEX_PARSE_BATCH = 512;

function* forecastExPairRows(csv, { allowedPrefixes = [] } = {}) {
  const raw = String(csv || '').replace(/^\uFEFF/, '');
  if (!raw || Buffer.byteLength(raw, 'utf8') > MAX_RESPONSE_BYTES) {
    throw sourceError('ForecastEx execution tape was empty or oversized.', 'PM_TEST_FORECASTEX_PAIRS_INVALID');
  }
  let headers;
  let start = 0;
  while (start < raw.length) {
    const newline = raw.indexOf('\n', start);
    const end = newline < 0 ? raw.length : newline;
    const line = raw.slice(start, newline >= 0 && raw[end - 1] === '\r' ? end - 1 : end);
    start = newline < 0 ? raw.length : end + 1;
    if (!line.trim()) { yield null; continue; }
    if (!headers) {
      headers = parseCsvLine(line).map((header) => header.toLowerCase());
      if (headers.length !== FORECASTEX_PAIR_COLUMNS.length
        || FORECASTEX_PAIR_COLUMNS.some((column, index) => headers[index] !== column)) {
        throw sourceError('ForecastEx execution tape schema changed.', 'PM_TEST_FORECASTEX_PAIRS_SCHEMA_INVALID');
      }
      yield null;
      continue;
    }
    const values = parseCsvLine(line);
    if (values.length !== headers.length) throw sourceError('ForecastEx execution row shape changed.', 'PM_TEST_FORECASTEX_PAIRS_INVALID');
    const row = Object.fromEntries(headers.map((header, index) => [header, values[index]]));
    if (allowedPrefixes.length && !allowedPrefixes.some((prefix) => row.event_contract.startsWith(prefix))) { yield null; continue; }
    const yesPrice = finiteNumber(row.yes_price, { min: 0, max: 1 });
    const noPrice = finiteNumber(row.no_price, { min: 0, max: 1 });
    const pairTime = isoTimestamp(row.pair_time);
    if (!row.pair_id || !row.event_contract || yesPrice == null || noPrice == null || !pairTime) {
      throw sourceError('ForecastEx execution row contained invalid values.', 'PM_TEST_FORECASTEX_PAIRS_INVALID');
    }
    const candidate = {
      pairId: row.pair_id,
      contractId: row.event_contract,
      expirationDate: row.expiration_date || null,
      quantity: finiteNumber(row.quantity, { min: 0 }),
      yesPrice,
      noPrice,
      pairTime,
    };
    yield candidate;
  }
  if (!headers) throw sourceError('ForecastEx execution tape was empty.', 'PM_TEST_FORECASTEX_PAIRS_INVALID');
}

function compareForecastExPairs(left, right) {
  return Date.parse(left.pairTime) - Date.parse(right.pairTime)
    || left.contractId.localeCompare(right.contractId)
    || left.pairId.localeCompare(right.pairId);
}

function parseForecastExPairRows(csv, options) {
  const executions = [];
  for (const row of forecastExPairRows(csv, options)) if (row) executions.push(row);
  return executions.sort(compareForecastExPairs);
}

async function parseForecastExPairRowsAsync(csv, options) {
  const entries = [];
  let processed = 0;
  // Yield even for blank or filtered rows. A large source tape must leave the
  // API event loop available for chat acceptance, Stop, and health checks.
  for (const value of forecastExPairRows(csv, options)) {
    if (value) entries.push({ value, time: Date.parse(value.pairTime) });
    if (++processed % FORECASTEX_PARSE_BATCH === 0) await yieldEventLoop();
  }
  const compare = (left, right) => left.time - right.time
    || left.value.contractId.localeCompare(right.value.contractId)
    || left.value.pairId.localeCompare(right.value.pairId);
  let ordered = entries;
  // Sort bounded runs and merge them cooperatively. Timestamp keys stay
  // internal; every original execution and stable tie order is preserved.
  for (let start = 0; start < ordered.length; start += FORECASTEX_PARSE_BATCH) {
    const batch = ordered.slice(start, start + FORECASTEX_PARSE_BATCH).sort(compare);
    for (let index = 0; index < batch.length; index += 1) ordered[start + index] = batch[index];
    if (ordered.length > FORECASTEX_PARSE_BATCH) await yieldEventLoop();
  }
  let buffer = new Array(ordered.length);
  for (let width = FORECASTEX_PARSE_BATCH; width < ordered.length; width *= 2) {
    for (let start = 0; start < ordered.length; start += width * 2) {
      const middle = Math.min(start + width, ordered.length);
      const end = Math.min(start + width * 2, ordered.length);
      let left = start;
      let right = middle;
      for (let index = start; index < end; index += 1) {
        buffer[index] = right >= end || left < middle && compare(ordered[left], ordered[right]) <= 0
          ? ordered[left++] : ordered[right++];
        if ((index + 1) % FORECASTEX_PARSE_BATCH === 0) await yieldEventLoop();
      }
    }
    const previous = ordered;
    ordered = buffer;
    buffer = previous;
  }
  const executions = [];
  for (let index = 0; index < ordered.length; index += 1) {
    executions.push(ordered[index].value);
    if ((index + 1) % FORECASTEX_PARSE_BATCH === 0) await yieldEventLoop();
  }
  return executions;
}

function parseForecastExPairsCsv(csv, { allowedPrefixes = [] } = {}) {
  const latestByContract = new Map();
  parseForecastExPairRows(csv, { allowedPrefixes }).forEach((candidate) => {
    const previous = latestByContract.get(candidate.contractId);
    if (!previous || Date.parse(candidate.pairTime) >= Date.parse(previous.pairTime)) {
      latestByContract.set(candidate.contractId, candidate);
    }
  });
  return [...latestByContract.values()].sort((left, right) => left.contractId.localeCompare(right.contractId));
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function parseBlsReleaseHtml(html, { reportMonthLabel } = {}) {
  const raw = String(html || '');
  if (/access denied/i.test(raw)) throw sourceError('BLS blocked the release HTML request.', 'PM_TEST_BLS_RELEASE_ACCESS_DENIED');
  const text = stripHtml(raw);
  if (!text || !reportMonthLabel || !new RegExp(`\\b${reportMonthLabel.replace(' ', '\\s+')}\\b`, 'i').test(text)) {
    return { matchedReportMonth: false, value: null, sentence: null };
  }
  const paragraphs = [...raw.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((match) => stripHtml(match[1]));
  const candidates = [...paragraphs, text].filter((candidate) => /last 12 months/i.test(candidate) && /all items/i.test(candidate));
  for (const candidate of candidates) {
    const sentence = candidate.match(/(?:Over the last 12 months|The all items index)[^.]*?(?:increased|rose|advanced)\s+(-?\d+(?:\.\d+)?)\s+percent[^.]*\./i)?.[0]
      || candidate.match(/(?:increased|rose|advanced)\s+(-?\d+(?:\.\d+)?)\s+percent[^.]{0,180}(?:last 12 months|12-month)[^.]*\./i)?.[0];
    if (!sentence) continue;
    const valueMatch = sentence.match(/(?:increased|rose|advanced)\s+(-?\d+(?:\.\d+)?)\s+percent/i);
    const value = finiteNumber(valueMatch?.[1], { min: -20, max: 50 });
    if (value != null) return { matchedReportMonth: true, value: Number(value.toFixed(1)), sentence };
  }
  return { matchedReportMonth: true, value: null, sentence: null };
}

function normalizeBlsApiYoY(payload, { seriesId, reportMonth, priorYearMonth } = {}) {
  const series = Array.isArray(payload?.Results?.series) ? payload.Results.series : [];
  const selected = series.find((entry) => entry?.seriesID === seriesId);
  if (!selected || !Array.isArray(selected.data)) return null;
  const values = new Map();
  selected.data.forEach((observation) => {
    const period = String(observation?.period || '').match(/^M(0[1-9]|1[0-2])$/)?.[1];
    const year = String(observation?.year || '').match(/^20\d{2}$/)?.[0];
    const value = finiteNumber(observation?.value, { min: 0 });
    if (period && year && value != null) values.set(`${year}-${period}`, value);
  });
  const current = values.get(reportMonth);
  const prior = values.get(priorYearMonth);
  if (!Number.isFinite(current) || !Number.isFinite(prior) || prior <= 0) return null;
  return {
    value: Number((((current / prior) - 1) * 100).toFixed(1)),
    currentIndex: current,
    priorIndex: prior,
  };
}

function parseBlsRss(xml, { reportMonthLabel } = {}) {
  const raw = String(xml || '');
  if (/access denied/i.test(raw)) throw sourceError('BLS blocked the CPI RSS request.', 'PM_TEST_BLS_RSS_ACCESS_DENIED');
  const items = [...raw.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((match) => stripHtml(match[1]));
  const item = items.find((candidate) => new RegExp(reportMonthLabel.replace(' ', '\\s+'), 'i').test(candidate));
  return item ? { detected: true, item: item.slice(0, 500) } : { detected: false, item: null };
}

function createSourceCache({ nowMs = Date.now } = {}) {
  const entries = new Map();
  const inFlight = new Map();
  const health = new Map();
  async function get(provider, key, ttlMs, loader, { forceRefresh = false, refreshAfter } = {}) {
    const cacheKey = `${provider}:${key}`;
    const startedAt = nowMs();
    const boundary = Number.isFinite(refreshAfter) ? refreshAfter : startedAt;
    const current = entries.get(cacheKey);
    if (current && startedAt < current.expiresAt && (!forceRefresh || (Number.isFinite(refreshAfter) && current.startedAt >= boundary))) return current.value;
    const pending = inFlight.get(cacheKey);
    if (pending && (!forceRefresh || pending.startedAt >= boundary)) return pending.promise;
    const acquisition = { startedAt, promise: null };
    acquisition.promise = Promise.resolve().then(loader).then((value) => {
      if (inFlight.get(cacheKey) === acquisition) {
        entries.set(cacheKey, { value, startedAt, expiresAt: nowMs() + ttlMs });
        health.set(provider, { status: 'available', lastSuccessAt: new Date(nowMs()).toISOString(), error: null });
      }
      return value;
    }).catch((error) => {
      if (inFlight.get(cacheKey) === acquisition) {
        entries.delete(cacheKey);
        health.set(provider, {
          status: 'unavailable',
          lastSuccessAt: health.get(provider)?.lastSuccessAt || null,
          error: { code: error.code || 'SOURCE_UNAVAILABLE', message: String(error.message || error).slice(0, 300) },
        });
      }
      throw error;
    }).finally(() => { if (inFlight.get(cacheKey) === acquisition) inFlight.delete(cacheKey); });
    inFlight.set(cacheKey, acquisition);
    return acquisition.promise;
  }
  return {
    get,
    health(provider) {
      return health.get(provider) || { status: 'not_started', lastSuccessAt: null, error: null };
    },
  };
}

async function fetchText(url, {
  fetchImpl,
  accept,
  method = 'GET',
  body,
  headers = {},
} = {}) {
  if (typeof fetchImpl !== 'function') throw sourceError('No HTTP fetch implementation is available.', 'PM_TEST_FETCH_UNAVAILABLE');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      body,
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        accept,
        'user-agent': 'market-dashboard-resolver-monitor/1.0',
        ...headers,
      },
    });
  } catch (error) {
    throw sourceError(
      'Remote source request failed.',
      error?.name === 'AbortError' ? 'PM_TEST_FETCH_TIMEOUT' : 'PM_TEST_FETCH_UNAVAILABLE',
    );
  } finally {
    clearTimeout(timer);
  }
  if (!response?.ok) {
    throw sourceError(`Remote source returned HTTP ${response?.status || 'error'}.`, `PM_TEST_HTTP_${response?.status || 'ERROR'}`);
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
    throw sourceError('Remote source response was oversized.', 'PM_TEST_RESPONSE_OVERSIZED');
  }
  return { text, response };
}

function createPublicSources({
  fetchImpl = global.fetch,
  now = () => new Date(),
  env = process.env,
} = {}) {
  const cache = createSourceCache({ nowMs: () => now().getTime() });

  async function getKalshiEvent(eventTicker, refreshOptions = {}) {
    return cache.get('kalshi', eventTicker, 2_500, async () => {
      const url = `${KALSHI_PUBLIC_BASE_URL}/events/${encodeURIComponent(eventTicker)}?with_nested_markets=true`;
      const { text } = await fetchText(url, { fetchImpl, accept: 'application/json' });
      let payload;
      try {
        payload = JSON.parse(text);
      } catch (_) {
        throw sourceError('Kalshi returned invalid JSON.', 'PM_TEST_KALSHI_SCHEMA_INVALID');
      }
      return normalizeKalshiEvent(payload, { eventTicker, fetchedAt: now().toISOString() });
    }, refreshOptions);
  }

  async function getForecastExContracts(productId, refreshOptions = {}) {
    return cache.get('forecastex', `contracts:${productId}`, 5_000, async () => {
      const url = `${FORECASTEX_BASE_URL}/contracts?page=1&pageSize=1000&productId=${encodeURIComponent(productId)}`;
      const { text } = await fetchText(url, { fetchImpl, accept: 'application/json' });
      let payload;
      try {
        payload = JSON.parse(text);
      } catch (_) {
        throw sourceError('ForecastEx returned invalid JSON.', 'PM_TEST_FORECASTEX_SCHEMA_INVALID');
      }
      return {
        provider: 'forecastex_public_contracts',
        productId,
        fetchedAt: now().toISOString(),
        lines: parseForecastExContractsResponse(payload, { productId }),
      };
    }, refreshOptions);
  }

  async function getForecastExPairTape(dataDate, refreshOptions = {}) {
    return cache.get('forecastex', `pairs:${dataDate}`, 5_000, async () => {
      const url = `${FORECASTEX_BASE_URL}/download?type=pairs&date=${encodeURIComponent(dataDate)}`;
      const { text } = await fetchText(url, { fetchImpl, accept: 'text/csv' });
      return {
        dataDate,
        fetchedAt: now().toISOString(),
        executions: await parseForecastExPairRowsAsync(text),
      };
    }, refreshOptions);
  }

  async function getForecastExPairs(dataDate, allowedPrefixes, refreshOptions = {}) {
    const prefixes = [...(allowedPrefixes || [])].sort();
    const prefixKey = prefixes.join('|');
    return cache.get('forecastex', `pairs-filtered:${dataDate}:${prefixKey}`, 5_000, async () => {
      // ForecastEx publishes one large tape per date. All market monitors need
      // subsets of that same payload, so download and parse it once per TTL
      // instead of repeating the synchronous CSV parse for every product.
      const tape = await getForecastExPairTape(dataDate, refreshOptions);
      const executions = prefixes.length
        ? tape.executions.filter((execution) => prefixes.some((prefix) => execution.contractId.startsWith(prefix)))
        : tape.executions;
      const latestByContract = new Map();
      executions.forEach((execution) => {
        const previous = latestByContract.get(execution.contractId);
        if (!previous || Date.parse(execution.pairTime) >= Date.parse(previous.pairTime)) {
          latestByContract.set(execution.contractId, execution);
        }
      });
      return {
        provider: 'forecastex_public_execution_tape',
        dataDate,
        fetchedAt: tape.fetchedAt,
        trades: [...latestByContract.values()].sort((left, right) => left.contractId.localeCompare(right.contractId)),
        executions,
      };
    }, refreshOptions);
  }

  async function getCoinbaseSpot(productId, refreshOptions = {}) {
    const expected = String(productId || '').trim().toUpperCase();
    return cache.get('coinbase', expected, 750, async () => {
      const url = `${COINBASE_BASE_URL}/products/${encodeURIComponent(expected)}/ticker`;
      const { text } = await fetchText(url, { fetchImpl, accept: 'application/json' });
      let payload;
      try {
        payload = JSON.parse(text);
      } catch (_) {
        throw sourceError('Coinbase returned invalid JSON.', 'PM_TEST_COINBASE_SCHEMA_INVALID');
      }
      return normalizeCoinbaseTicker(payload, { productId: expected, fetchedAt: now().toISOString() });
    }, refreshOptions);
  }

  async function getBlsCpi(product, refreshOptions = {}) {
    const nowDate = now();
    const releaseAt = Date.parse(product.releaseAt || '');
    const nearRelease = Number.isFinite(releaseAt) && nowDate.getTime() >= releaseAt - 15 * 60 * 1000;
    if (!nearRelease) {
      return {
        provider: 'bls',
        availability: 'pending_release',
        value: null,
        reportMonth: product.bls.reportMonth,
        releaseAt: product.releaseAt,
        primary: { status: 'not_checked', source: BLS_RELEASE_URL },
        rss: { status: 'not_checked', source: BLS_RSS_URL },
        verifier: { status: 'not_checked', source: BLS_API_URL },
      };
    }

    const sourceTtl = 2_000;
    const releasePromise = cache.get('bls_release', product.bls.reportMonth, sourceTtl, async () => {
      const { text } = await fetchText(BLS_RELEASE_URL, { fetchImpl, accept: 'text/html' });
      return parseBlsReleaseHtml(text, { reportMonthLabel: product.bls.reportMonthLabel });
    }, refreshOptions);
    const rssPromise = cache.get('bls_rss', product.bls.reportMonth, sourceTtl, async () => {
      const { text } = await fetchText(BLS_RSS_URL, { fetchImpl, accept: 'application/rss+xml, application/xml, text/xml' });
      return parseBlsRss(text, { reportMonthLabel: product.bls.reportMonthLabel });
    }, refreshOptions);
    const apiPromise = nowDate.getTime() >= releaseAt
      ? cache.get('bls_api', product.bls.reportMonth, 10_000, async () => {
        const body = {
          seriesid: [product.bls.seriesId],
          startyear: String(Number(product.bls.reportMonth.slice(0, 4)) - 1),
          endyear: product.bls.reportMonth.slice(0, 4),
        };
        if (env.BLS_API_KEY) body.registrationkey = env.BLS_API_KEY;
        const { text } = await fetchText(BLS_API_URL, {
          fetchImpl,
          accept: 'application/json',
          method: 'POST',
          body: JSON.stringify(body),
          headers: { 'content-type': 'application/json' },
        });
        let payload;
        try {
          payload = JSON.parse(text);
        } catch (_) {
          throw sourceError('BLS API returned invalid JSON.', 'PM_TEST_BLS_API_INVALID');
        }
        if (String(payload?.status || '').toUpperCase() !== 'REQUEST_SUCCEEDED') {
          throw sourceError('BLS API request did not succeed.', 'PM_TEST_BLS_API_UNAVAILABLE');
        }
        return normalizeBlsApiYoY(payload, product.bls);
      }, refreshOptions)
      : Promise.resolve(null);

    const [releaseResult, rssResult, apiResult] = await Promise.allSettled([releasePromise, rssPromise, apiPromise]);
    const release = releaseResult.status === 'fulfilled' ? releaseResult.value : null;
    const api = apiResult.status === 'fulfilled' ? apiResult.value : null;
    const primaryStatus = releaseResult.status === 'rejected'
      ? { status: 'unavailable', source: BLS_RELEASE_URL, error: releaseResult.reason?.code || 'PM_TEST_BLS_RELEASE_UNAVAILABLE' }
      : { status: release?.matchedReportMonth ? (release.value != null ? 'confirmed' : 'report_detected') : 'pending', source: BLS_RELEASE_URL };
    const rssStatus = rssResult.status === 'rejected'
      ? { status: 'unavailable', source: BLS_RSS_URL, error: rssResult.reason?.code || 'PM_TEST_BLS_RSS_UNAVAILABLE' }
      : { status: rssResult.value?.detected ? 'detected' : 'pending', source: BLS_RSS_URL };
    const verifierStatus = apiResult.status === 'rejected'
      ? { status: 'unavailable', source: BLS_API_URL, error: apiResult.reason?.code || 'PM_TEST_BLS_API_UNAVAILABLE' }
      : { status: api ? 'confirmed' : 'pending', source: BLS_API_URL, currentIndex: api?.currentIndex || null, priorIndex: api?.priorIndex || null };

    if (release?.value != null && api?.value != null && release.value !== api.value) {
      return {
        provider: 'bls',
        availability: 'unavailable',
        errorCode: 'PM_TEST_BLS_VERIFICATION_CONFLICT',
        value: null,
        releaseValue: release.value,
        verifierValue: api.value,
        reportMonth: product.bls.reportMonth,
        releaseAt: product.releaseAt,
        primary: primaryStatus,
        rss: rssStatus,
        verifier: verifierStatus,
      };
    }
    if (release?.value != null) {
      return {
        provider: 'bls',
        availability: 'official_final',
        value: release.value,
        reportMonth: product.bls.reportMonth,
        releaseAt: product.releaseAt,
        asOf: nowDate.toISOString(),
        method: 'literal_release_sentence',
        sentence: release.sentence,
        primary: primaryStatus,
        rss: rssStatus,
        verifier: verifierStatus,
      };
    }
    if (api?.value != null) {
      return {
        provider: 'bls',
        availability: 'official_preliminary',
        value: api.value,
        reportMonth: product.bls.reportMonth,
        releaseAt: product.releaseAt,
        asOf: nowDate.toISOString(),
        method: 'official_index_verifier_only',
        warning: 'BLS API indices are available, but the literal release sentence has not been confirmed.',
        primary: primaryStatus,
        rss: rssStatus,
        verifier: verifierStatus,
      };
    }
    return {
      provider: 'bls',
      availability: 'pending_release',
      value: null,
      reportMonth: product.bls.reportMonth,
      releaseAt: product.releaseAt,
      primary: primaryStatus,
      rss: rssStatus,
      verifier: verifierStatus,
    };
  }

  function getHealth() {
    return {
      kalshi: cache.health('kalshi'),
      forecastex: cache.health('forecastex'),
      blsRelease: cache.health('bls_release'),
      blsRss: cache.health('bls_rss'),
      blsApi: cache.health('bls_api'),
      coinbase: cache.health('coinbase'),
    };
  }

  return {
    getBlsCpi,
    getCoinbaseSpot,
    getForecastExContracts,
    getForecastExPairs,
    getHealth,
    getKalshiEvent,
  };
}

module.exports = {
  BLS_API_URL,
  BLS_RELEASE_URL,
  BLS_RSS_URL,
  COINBASE_BASE_URL,
  FORECASTEX_BASE_URL,
  KALSHI_PUBLIC_BASE_URL,
  createPublicSources,
  normalizeBlsApiYoY,
  normalizeCoinbaseTicker,
  normalizeKalshiEvent,
  parseBlsReleaseHtml,
  parseBlsRss,
  parseCsvLine,
  parseForecastExContractsResponse,
  parseForecastExPairRows,
  parseForecastExPairRowsAsync,
  parseForecastExPairsCsv,
  parseFesResolverIdentity,
  forecastExTimestamp,
};
