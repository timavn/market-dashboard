const axios = require('axios');

const DAY_MS = 86_400_000;
const CACHE_TTL_MS = 15 * 60_000;
const SERIES = Object.freeze({
  BUND10Y: Object.freeze({
    source: 'bundesbank',
    seriesId: 'BBSSY.D.REN.EUR.A630.000000WT1010.A',
    sourceInstrument: 'Daily yield of the current 10 year German federal bond',
    sourceUrl: 'https://www.bundesbank.de/en/statistics/money-and-capital-markets/interest-rates-and-yields/daily-yields-of-current-federal-securities-772220',
    dataUrl: 'https://api.statistiken.bundesbank.de/rest/data/BBSSY/D.REN.EUR.A630.000000WT1010.A',
  }),
  JGB10Y: Object.freeze({
    source: 'japan_mof',
    seriesId: 'JGB_CONSTANT_MATURITY_10Y',
    sourceInstrument: 'Japan government bond 10 year constant maturity yield',
    sourceUrl: 'https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/index.htm',
    dataUrl: 'https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/jgbcme.csv',
    historyUrl: 'https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/historical/jgbcme_all.csv',
  }),
  GILT10Y: Object.freeze({
    source: 'bank_of_england',
    seriesId: 'IUDMNPY',
    sourceInstrument: 'British government securities 10 year nominal par yield (published yield curve)',
    sourceUrl: 'https://www.bankofengland.co.uk/boeapps/database/index.asp?Travel=NIxSUx&levels=1&XNotes=Y&A3951XNode3951.x=10&A3951XNode3951.y=10&Nodes=&SectionRequired=I&HideNums=-1&ExtraInfo=true&EC=IUDMNPY',
    dataUrl: 'https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp',
  }),
  CAN10Y: Object.freeze({
    source: 'bank_of_canada',
    seriesId: 'BD.CDN.10YR.DQ.YLD',
    sourceInstrument: 'Government of Canada 10 year benchmark bond yield',
    sourceUrl: 'https://www.bankofcanada.ca/rates/interest-rates/canadian-bonds/',
    dataUrl: 'https://www.bankofcanada.ca/valet/observations/BD.CDN.10YR.DQ.YLD/csv',
  }),
  ACGB10Y: Object.freeze({
    source: 'rba',
    seriesId: 'FCMYGBAG10D',
    sourceInstrument: 'Australian Government 10 year bond yield, interpolated (RBA F2)',
    sourceUrl: 'https://www.rba.gov.au/statistics/tables/#interest-rates',
    dataUrl: 'https://www.rba.gov.au/statistics/tables/csv/f2-data.csv',
  }),
});
// Where each publisher puts its series column and how it writes dates.
const HEADER_LABELS = Object.freeze({ JGB10Y: ['Date', '10Y'], GILT10Y: ['DATE'], CAN10Y: ['date'], ACGB10Y: ['Series ID'] });
const DATE_FORMATS = Object.freeze({ JGB10Y: 'ymd-slash', GILT10Y: 'dmy-space', ACGB10Y: 'dmy-dash' });
const clientCaches = new WeakMap();
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function csvFields(line) {
  const fields = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') { field += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) { fields.push(field.trim()); field = ''; }
    else field += char;
  }
  fields.push(field.trim());
  return quoted ? [] : fields;
}

function dateNumber(value, symbol) {
  let parts;
  const format = DATE_FORMATS[symbol];
  if (format === 'dmy-space' || format === 'dmy-dash') {
    const match = (format === 'dmy-space' ? /^(\d{1,2}) ([A-Za-z]{3}) (\d{4})$/ : /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/).exec(value);
    if (!match) return null;
    parts = [Number(match[3]), MONTHS.indexOf(match[2]), Number(match[1])];
  } else {
    const match = (format === 'ymd-slash' ? /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/ : /^(\d{4})-(\d{2})-(\d{2})$/).exec(value);
    if (!match) return null;
    parts = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
  }
  const [year, month, day] = parts;
  const t = Date.UTC(year, month, day);
  const date = new Date(t);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month && date.getUTCDate() === day ? t : null;
}

/** Parse only the explicitly identified daily series; notes and missing cells are not observations. */
function parseOfficialSovereignCsv(symbol, csv, { now = Date.now(), startDate } = {}) {
  const config = SERIES[symbol];
  if (!config || typeof csv !== 'string' || !Number.isFinite(now)) return [];
  const lines = csv.replace(/^\uFEFF/, '').split(/\r?\n/).map(csvFields);
  const [rowLabel, columnLabel = config.seriesId] = HEADER_LABELS[symbol] || [];
  const headerIndex = lines.findIndex(fields => symbol === 'BUND10Y'
    ? fields[1] === config.seriesId
    : fields[0] === rowLabel && fields.includes(columnLabel));
  if (headerIndex < 0) return [];
  const column = symbol === 'BUND10Y' ? 1 : lines[headerIndex].indexOf(columnLabel);
  const start = startDate ? Date.parse(`${startDate}T00:00:00Z`) : -Infinity;
  if (Number.isNaN(start)) return [];
  const byDate = new Map();
  for (const fields of lines.slice(headerIndex + 1)) {
    const t = dateNumber(fields[0] || '', symbol);
    const raw = fields[column] || '';
    // Number('') and parseFloat('3.1 footnote') would manufacture valid observations.
    if (t === null || t < start || t > now || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)) continue;
    const close = Number(raw);
    if (Number.isFinite(close)) byDate.set(t, { t, close });
  }
  return [...byDate.values()].sort((left, right) => left.t - right.t);
}

function dataUrls(symbol, startDate, endDate) {
  const config = SERIES[symbol];
  if (symbol === 'JGB10Y') return [config.historyUrl, config.dataUrl];
  // The RBA publishes one complete daily file; the parser applies the window.
  if (symbol === 'ACGB10Y') return [config.dataUrl];
  const url = new URL(config.dataUrl);
  if (symbol === 'CAN10Y') {
    url.search = new URLSearchParams({ start_date: startDate, end_date: endDate }).toString();
  } else if (symbol === 'BUND10Y') {
    url.search = new URLSearchParams({ format: 'csv', lang: 'en', startPeriod: startDate, endPeriod: endDate }).toString();
  } else {
    const boeDate = date => { const [year, month, day] = date.split('-'); return `${day}/${MONTHS[Number(month) - 1]}/${year}`; };
    url.search = new URLSearchParams({
      'csv.x': 'yes', Datefrom: boeDate(startDate), Dateto: boeDate(endDate),
      SeriesCodes: config.seriesId, CSVF: 'TN', UsingCodes: 'Y', VPD: 'Y', VFD: 'N',
    }).toString();
  }
  return [url.toString()];
}

/**
 * Official daily reference yields, never executable quotes. Quotes and period
 * comparisons must consume this same series to avoid mixing monthly averages,
 * current benchmark bonds, constant-maturity yields, and nominal par curves.
 */
async function fetchOfficialSovereignSeries(symbol, {
  httpClient = axios, now = Date.now(), startDate, forceRefresh = false,
} = {}) {
  const normalizedSymbol = String(symbol || '').trim().toUpperCase();
  const config = SERIES[normalizedSymbol];
  if (!config || !Number.isFinite(now)) return null;
  const from = startDate || new Date(now - 520 * DAY_MS).toISOString().slice(0, 10);
  const fromTime = Date.parse(`${from}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !Number.isFinite(fromTime) || fromTime > now
      || new Date(fromTime).toISOString().slice(0, 10) !== from) return null;
  const to = new Date(now).toISOString().slice(0, 10);
  if (!clientCaches.has(httpClient)) clientCaches.set(httpClient, new Map());
  const cache = clientCaches.get(httpClient);
  const key = `${normalizedSymbol}:${from}:${to}`;
  const previous = cache.get(key);
  if (!forceRefresh && previous && now >= previous.startedAt && previous.expiresAt > now) return previous.promise;

  const entry = { startedAt: now, expiresAt: now + CACHE_TTL_MS, promise: null };
  entry.promise = Promise.all(dataUrls(normalizedSymbol, from, to).map(async (url) => {
    const response = await httpClient.get(url, {
      timeout: 15_000,
      headers: { Accept: 'text/csv, application/csv, application/vnd.bbk.data+csv', 'User-Agent': 'market-dashboard/1.0' },
      responseType: 'text',
    });
    if (response.status !== 200 || typeof response.data !== 'string') throw new Error('Invalid official yield response');
    const closes = parseOfficialSovereignCsv(normalizedSymbol, response.data, { now, startDate: from });
    // A valid current-month Japan file can contain no entries before the first
    // daily publication. Validate its header without requiring a current value.
    if (!closes.length && !parseOfficialSovereignCsv(normalizedSymbol, response.data, { now }).length
        && !(normalizedSymbol === 'JGB10Y' && response.data.split(/\r?\n/).some(line => {
          const fields = csvFields(line);
          return fields[0] === 'Date' && fields.includes('10Y');
        }))) throw new Error('Official yield series unavailable');
    return closes;
  })).then(parts => {
    const byDate = new Map();
    // Current-month Japan observations take precedence over its monthly archive.
    parts.flat().forEach(point => byDate.set(point.t, point));
    const closes = [...byDate.values()].sort((left, right) => left.t - right.t);
    if (!closes.length) throw new Error('Official yield series unavailable');
    return {
      symbol: normalizedSymbol, source: config.source, seriesId: config.seriesId,
      sourceUrl: config.sourceUrl, sourceInstrument: config.sourceInstrument,
      observationFrequency: 'daily', dataType: 'historical',
      receivedAt: new Date(now).toISOString(), closes,
    };
  }).catch(() => {
    // Do not resurrect a previously fetched series on refresh failure. The
    // overview retention layer owns dated reference retention separately.
    if (cache.get(key) === entry) cache.delete(key);
    return null;
  });
  cache.set(key, entry);
  return entry.promise;
}

module.exports = { SERIES, parseOfficialSovereignCsv, fetchOfficialSovereignSeries };
