const crypto = require('node:crypto');

const OFFICIAL_FORECASTEX_DOWNLOAD_URL = 'https://www.forecastex.com/api/download';
const FORECASTEX_FETCH_TIMEOUT_MS = 12_000;
const MAX_FORECASTEX_CSV_BYTES = 8 * 1024 * 1024;
const SUPPORTED_FORECASTEX_PRODUCTS = Object.freeze(['COMCO', 'METLG', 'FES', 'CPIY']);
const REQUIRED_COLUMNS = Object.freeze([
  'event_contract',
  'subtype',
  'expiration_date',
  'date',
  'settlement_price',
]);

function sourceError(message, code) {
  return Object.assign(new Error(message), { code });
}

function normalizeDataDate(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(20\d{2})-?(0[1-9]|1[0-2])-?(0[1-9]|[12]\d|3[01])$/);
  if (!match) return null;
  const compact = `${match[1]}${match[2]}${match[3]}`;
  const parsed = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return parsed.toISOString().slice(0, 10).replaceAll('-', '') === compact
    ? { compact, iso: `${match[1]}-${match[2]}-${match[3]}` }
    : null;
}

function parseCsvLine(line) {
  const values = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      values.push(value);
      value = '';
    } else {
      value += character;
    }
  }
  if (quoted) throw sourceError('The official ForecastEx CSV contained an unterminated quoted field.', 'FORECASTEX_PRICES_CSV_INVALID');
  values.push(value);
  return values.map((entry) => entry.trim());
}

function finitePrice(value) {
  if (value == null || String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : null;
}

function parseOfficialForecastExPricesCsv(csv, { dataDate } = {}) {
  const normalizedDate = normalizeDataDate(dataDate);
  if (!normalizedDate) throw sourceError('An exact ForecastEx data date is required.', 'FORECASTEX_PRICES_DATE_INVALID');
  const raw = String(csv || '').replace(/^\uFEFF/, '');
  if (!raw || Buffer.byteLength(raw, 'utf8') > MAX_FORECASTEX_CSV_BYTES) {
    throw sourceError('The official ForecastEx prices file was empty or oversized.', 'FORECASTEX_PRICES_CSV_INVALID');
  }
  const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length < 2) throw sourceError('The official ForecastEx prices file contained no rows.', 'FORECASTEX_PRICES_CSV_INVALID');
  const headers = parseCsvLine(lines[0]).map((header) => header.toLowerCase());
  if (new Set(headers).size !== headers.length || REQUIRED_COLUMNS.some((column) => !headers.includes(column))) {
    throw sourceError('The official ForecastEx prices schema was missing or ambiguous.', 'FORECASTEX_PRICES_SCHEMA_INVALID');
  }
  const rows = [];
  const seen = new Set();
  for (const line of lines.slice(1)) {
    const values = parseCsvLine(line);
    if (values.length !== headers.length) throw sourceError('The official ForecastEx prices row shape was invalid.', 'FORECASTEX_PRICES_CSV_INVALID');
    const row = Object.fromEntries(headers.map((header, index) => [header, values[index]]));
    const eventContract = String(row.event_contract || '').trim().toUpperCase();
    const productCode = eventContract.match(/^([A-Z0-9]+)_/)?.[1] || null;
    if (!SUPPORTED_FORECASTEX_PRODUCTS.includes(productCode)) continue;
    if (!/^(?:(?:COMCO|METLG|FES)_\d{6}|CPIY_\d{4})_-?\d+(?:\.\d+)?$/.test(eventContract)) {
      throw sourceError('The official ForecastEx row identity was inconsistent.', 'FORECASTEX_PRICES_IDENTITY_INVALID');
    }
    const subtype = String(row.subtype || '').toUpperCase();
    const settlementPrice = finitePrice(row.settlement_price);
    if (!['YES', 'NO'].includes(subtype) || row.date !== normalizedDate.iso) {
      throw sourceError('The official ForecastEx row identity was inconsistent.', 'FORECASTEX_PRICES_IDENTITY_INVALID');
    }
    const key = `${eventContract}:${subtype}`;
    if (seen.has(key)) throw sourceError('The official ForecastEx prices contained duplicate outcomes.', 'FORECASTEX_PRICES_IDENTITY_INVALID');
    seen.add(key);
    rows.push({
      eventContract,
      productCode,
      subtype,
      expirationDate: row.expiration_date || null,
      dataDate: row.date,
      settlementPrice,
    });
  }
  return rows;
}

async function loadOfficialForecastExPrices({
  dataDate,
  fetchImpl = global.fetch,
  now = () => new Date(),
  baseUrl = OFFICIAL_FORECASTEX_DOWNLOAD_URL,
} = {}) {
  const normalizedDate = normalizeDataDate(dataDate);
  if (!normalizedDate) throw sourceError('An exact ForecastEx data date is required.', 'FORECASTEX_PRICES_DATE_INVALID');
  if (typeof fetchImpl !== 'function') throw sourceError('No HTTP client is available for ForecastEx official prices.', 'FORECASTEX_PRICES_FETCH_UNAVAILABLE');
  const url = new URL(baseUrl);
  if (!/(^|\.)forecastex\.com$/i.test(url.hostname)) {
    throw sourceError('The ForecastEx prices source host is not authoritative.', 'FORECASTEX_PRICES_SOURCE_UNVERIFIED');
  }
  url.searchParams.set('type', 'prices');
  url.searchParams.set('date', normalizedDate.compact);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FORECASTEX_FETCH_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: { accept: 'text/csv' },
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (error) {
    throw sourceError(
      'The official ForecastEx prices file is unavailable.',
      error?.name === 'AbortError' ? 'FORECASTEX_PRICES_FETCH_TIMEOUT' : 'FORECASTEX_PRICES_FETCH_UNAVAILABLE',
    );
  } finally {
    clearTimeout(timer);
  }
  if (!response?.ok) {
    throw sourceError(
      'The official ForecastEx prices file returned an error.',
      response?.status === 404 ? 'FORECASTEX_PRICES_NOT_PUBLISHED' : 'FORECASTEX_PRICES_FETCH_UNAVAILABLE',
    );
  }
  const responseUrl = new URL(response.url || url.toString());
  if (!/(^|\.)forecastex\.com$/i.test(responseUrl.hostname)) {
    throw sourceError('The ForecastEx prices request redirected outside ForecastEx.', 'FORECASTEX_PRICES_SOURCE_UNVERIFIED');
  }
  const contentType = response.headers?.get?.('content-type');
  if (contentType && !/text\/csv/i.test(contentType)) {
    throw sourceError('The official ForecastEx prices response was not CSV.', 'FORECASTEX_PRICES_SOURCE_UNVERIFIED');
  }
  const csv = await response.text();
  const rows = parseOfficialForecastExPricesCsv(csv, { dataDate: normalizedDate.iso });
  return {
    ok: true,
    source: 'forecastex_official_prices',
    snapshotType: 'settled_outcome_candidates',
    dataDate: normalizedDate.iso,
    fetchedAt: now().toISOString(),
    url: responseUrl.toString(),
    sha256: crypto.createHash('sha256').update(csv).digest('hex'),
    rows,
  };
}

module.exports = {
  FORECASTEX_FETCH_TIMEOUT_MS,
  MAX_FORECASTEX_CSV_BYTES,
  OFFICIAL_FORECASTEX_DOWNLOAD_URL,
  SUPPORTED_FORECASTEX_PRODUCTS,
  loadOfficialForecastExPrices,
  normalizeDataDate,
  parseOfficialForecastExPricesCsv,
};
