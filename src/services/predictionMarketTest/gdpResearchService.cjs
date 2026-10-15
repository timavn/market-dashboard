const axios = require('axios/dist/node/axios.cjs');
const crypto = require('crypto');
const { zonedTimeToUtc } = require('date-fns-tz');
const {
  GDP_UNIT, GDP_METRIC, STAGES, normalizeGdpRecord, createGdpRecordStore,
} = require('./gdpResearchRecords.cjs');
const references = require('../../../data/research/gdp/reviewed-references.json');
const reviewedHedgeyeReference = require('../../../data/research/gdp/hedgeye-2026-08-31-reviewed.json');
const reviewedHedgeyeQ4Reference = require('../../../data/research/gdp/hedgeye-q4-2026-08-31-reviewed.json');
const historicalReferences = require('../../../data/research/gdp/official-history.json');
const { loadBeaHistory, loadGdpNowHistory } = require('./gdpHistoryService.cjs');

const DEFAULT_QUARTER = '2026-Q3';
const BEA_SCHEDULE_URL = 'https://www.bea.gov/news/schedule';
const BEA_GDP_URL = 'https://www.bea.gov/data/gdp/gross-domestic-product';
const GDPNOW_URL = 'https://www.atlantafed.org/research-and-data/data/gdpnow';
const STAGE_LABELS = { advance: 'First reading', second: 'First revision', third: 'Second revision' };
const OFFICIAL_LABELS = { advance: 'Advance', second: 'Second estimate', third: 'Third estimate' };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const QUARTER_WORDS = ['first', 'second', 'third', 'fourth'];

function plainText(html) {
  return String(html || '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'").replace(/&[mn]dash;|&#821[12];/gi, '–')
    .replace(/\s+/g, ' ').trim();
}

function quarterBounds(quarter) {
  if (!/^20\d{2}-Q[1-4]$/.test(quarter)) throw new Error('Invalid GDP quarter.');
  const year = Number(quarter.slice(0, 4));
  const number = Number(quarter.slice(-1));
  const month = (number - 1) * 3;
  return {
    quarter, quarterLabel: `Q${number} ${year}`, periodLabel: `${MONTHS[month]}–${MONTHS[month + 2]}`,
    periodStart: new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10),
    periodEnd: new Date(Date.UTC(year, month + 3, 0)).toISOString().slice(0, 10),
    previous: number === 1 ? `${year - 1}-Q4` : `${year}-Q${number - 1}`,
  };
}

function officialDate(month, day, year, clock = '08:30') {
  const index = MONTHS.findIndex((name) => name.toLowerCase() === String(month).toLowerCase());
  if (index < 0 || Number(day) < 1 || Number(day) > 31) return null;
  const date = `${year}-${String(index + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const utc = zonedTimeToUtc(`${date}T${clock}:00`, 'America/New_York');
  return Number.isFinite(utc.getTime()) ? utc.toISOString() : null;
}

function evidenceMeta(html, sourceUrl, verifiedAt) {
  return { sourceUrl, verifiedAt, evidenceSha256: crypto.createHash('sha256').update(String(html)).digest('hex') };
}

function parseBeaSchedule(html, { verifiedAt, sourceUrl = BEA_SCHEDULE_URL } = {}) {
  const records = [];
  for (const match of String(html).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const row = plainText(match[1]);
    const title = row.match(/\bGDP\s*\((Advance|Second|Third) Estimate\)[\s\S]*?([1-4])(?:st|nd|rd|th) Quarter (20\d{2})/i);
    const date = row.match(/\b([A-Z][a-z]+)\s+(\d{1,2})(?:,\s*(20\d{2}))?\s+(\d{1,2}):(\d{2})\s*(AM|PM)\b/);
    if (!title || !date) continue;
    const hour = Number(date[4]) % 12 + (date[6] === 'PM' ? 12 : 0);
    const stage = title[1].toLowerCase();
    const monthNumber = MONTHS.findIndex((month) => month === date[1]) + 1;
    const measuredYear = Number(title[3]);
    const calendarYear = [...plainText(String(html).slice(0, match.index)).matchAll(/\bYear\s+(20\d{2})/gi)].at(-1)?.[1];
    const releaseYear = Number(date[3] || calendarYear || measuredYear + (monthNumber <= Number(title[2]) * 3 ? 1 : 0));
    const releaseAt = officialDate(date[1], date[2], releaseYear, `${String(hour).padStart(2, '0')}:${date[5]}`);
    if (!releaseAt) continue;
    if (releaseAt.slice(0, 10) <= quarterBounds(`${title[3]}-Q${title[2]}`).periodEnd) continue;
    records.push(normalizeGdpRecord({
      kind: 'schedule', quarter: `${title[3]}-Q${title[2]}`, metric: GDP_METRIC, unit: GDP_UNIT, sourceId: 'bea',
      stage, releaseAt, ...evidenceMeta(html, sourceUrl, verifiedAt),
    }));
  }
  return records;
}

function parseGdpNow(html, { verifiedAt, sourceUrl = GDPNOW_URL } = {}) {
  const text = plainText(html);
  // Read only the explicitly dated headline; chart histories contain thousands
  // of unrelated rates, and the publication date is never the fetch date.
  const headline = text.match(/(-?\d+(?:\.\d+)?)\s*%+\s*(?:First|Second|Third|Fourth)[-– ]Quarter GDPNow Estimate for (20\d{2}):Q([1-4])\s+Updated:\s*([A-Za-z]+)\s+(\d{1,2}),\s*(20\d{2})/i);
  if (!headline || !/Quarterly percent change\s*\(SAAR\)/i.test(text) || !/real (?:gross domestic product|GDP)/i.test(text)) return null;
  const quarterWord = headline[0].match(/(First|Second|Third|Fourth)[-– ]Quarter/i)?.[1].toLowerCase();
  if (QUARTER_WORDS.indexOf(quarterWord) + 1 !== Number(headline[3])) return null;
  const month = MONTHS.findIndex((name) => name.toLowerCase() === headline[4].toLowerCase());
  if (month < 0) return null;
  return normalizeGdpRecord({
    kind: 'forecast', quarter: `${headline[2]}-Q${headline[3]}`, metric: GDP_METRIC, unit: GDP_UNIT,
    sourceId: 'gdpnow', value: Number(headline[1]),
    publishedAt: `${headline[6]}-${String(month + 1).padStart(2, '0')}-${headline[5].padStart(2, '0')}`,
    modelType: 'GDPNow statistical nowcast', targetStage: 'advance', latestPublicationConfirmed: true,
    ...evidenceMeta(html, sourceUrl, verifiedAt),
  });
}

function parseBeaReading(html, { verifiedAt, sourceUrl } = {}) {
  const text = plainText(html);
  const title = text.match(/\bGDP\s*\((Advance|Second|Third) Estimate\)[\s\S]{0,180}?([1-4])(?:st|nd|rd|th) Quarter (20\d{2})/i);
  const embargo = text.match(/EMBARGOED UNTIL RELEASE AT\s+(\d{1,2}):(\d{2})\s*a\.m\.\s+(EDT|EST),\s*[A-Za-z]+,\s*([A-Za-z]+)\s+(\d{1,2}),\s*(20\d{2})/i);
  const rate = text.match(/Real gross domestic product\s*\(GDP\)\s+(increased|decreased) at an annual rate of\s+(-?\d+(?:\.\d+)?)\s+percent in the (first|second|third|fourth) quarter of (20\d{2})/i);
  const zero = text.match(/Real gross domestic product\s*\(GDP\)\s+(?:was unchanged|did not change) in the (first|second|third|fourth) quarter of (20\d{2})/i);
  if (!title || !embargo || (!rate && !zero)) return null;
  const quarter = `${title[3]}-Q${title[2]}`;
  const describedQuarter = rate ? `${rate[4]}-Q${QUARTER_WORDS.indexOf(rate[3].toLowerCase()) + 1}` : `${zero[2]}-Q${QUARTER_WORDS.indexOf(zero[1].toLowerCase()) + 1}`;
  if (quarter !== describedQuarter) return null;
  const value = rate ? Number(rate[2]) * (rate[1].toLowerCase() === 'decreased' ? -1 : 1) : 0;
  const releasedAt = officialDate(embargo[4], embargo[5], embargo[6], `${embargo[1].padStart(2, '0')}:${embargo[2]}`);
  if (!releasedAt || Date.parse(releasedAt) > Date.parse(verifiedAt)) return null;
  return normalizeGdpRecord({
    kind: 'reading', quarter, stage: title[1].toLowerCase(), metric: GDP_METRIC, unit: GDP_UNIT, sourceId: 'bea',
    value, releasedAt, ...evidenceMeta(html, sourceUrl, verifiedAt),
  });
}

function beaReleaseLinks(html) {
  const found = new Set();
  for (const match of String(html).matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    if (!/\bGDP\s*\((Advance|Second|Third) Estimate\)/i.test(plainText(match[2]))) continue;
    try {
      const url = new URL(match[1], BEA_GDP_URL);
      if (url.hostname === 'www.bea.gov' && /^\/news\/20\d{2}\//.test(url.pathname)) found.add(url.href);
    } catch { /* Skip malformed links without guessing a release URL. */ }
  }
  return [...found];
}

async function defaultFetchText(url) {
  const result = await axios.get(url, { timeout: 12_000, responseType: 'text', maxContentLength: 20 * 1024 * 1024 });
  if (typeof result.data !== 'string') throw new Error('GDP source is not text.');
  return result.data;
}

function snapshotFromRecords(records, quarter = DEFAULT_QUARTER, { now = Date.now(), sourceStatus = [] } = {}) {
  const bounds = quarterBounds(quarter);
  const visible = records.filter((record) => Date.parse(record.publishedAt || record.releasedAt || record.verifiedAt) <= now);
  const byRecent = (a, b) => String(b.publishedAt || b.releasedAt || b.verifiedAt).localeCompare(String(a.publishedAt || a.releasedAt || a.verifiedAt)) || b.verifiedAt.localeCompare(a.verifiedAt);
  const schedules = (id) => STAGES.flatMap((stage) => {
    const record = visible.filter((r) => r.kind === 'schedule' && r.quarter === id && r.stage === stage).sort((a, b) => b.verifiedAt.localeCompare(a.verifiedAt))[0];
    return record ? [{ ...record, label: STAGE_LABELS[stage], officialLabel: OFFICIAL_LABELS[stage] }] : [];
  });
  const readings = (id) => visible.filter((r) => r.kind === 'reading' && r.quarter === id).sort((a, b) => a.releasedAt.localeCompare(b.releasedAt) || b.verifiedAt.localeCompare(a.verifiedAt));
  const forecastHistory = visible.filter((r) => r.kind === 'forecast' && r.quarter === quarter).sort(byRecent);
  const forecasts = ['hedgeye', 'gdpnow', 'consensus'].flatMap((sourceId) => {
    const record = forecastHistory.find((r) => r.sourceId === sourceId);
    return record ? [{ ...record }] : [];
  });
  return {
    ...bounds, metric: GDP_METRIC, unit: GDP_UNIT, unitLabel: 'QoQ SAAR', status: 'research_reference',
    schedule: schedules(quarter), forecasts, forecastHistory, readings: readings(quarter),
    readingHistory: visible.filter((r) => r.kind === 'reading').sort(byRecent),
    historicalForecasts: visible.filter((r) => r.kind === 'forecast').sort(byRecent),
    components: visible.filter((r) => r.kind === 'components').sort(byRecent),
    priorQuarter: { quarter: bounds.previous, schedule: schedules(bounds.previous), readings: readings(bounds.previous) },
    futureForecasts: visible.filter((r) => r.kind === 'forecast' && r.quarter > quarter).sort(byRecent),
    scheduleHistory: visible.filter((r) => r.kind === 'schedule' && [quarter, bounds.previous].includes(r.quarter)),
    sourceStatus, generatedAt: new Date(now).toISOString(),
    comparison: { operator: '>', gapUnit: 'percentage_points', gapDefinition: 'threshold minus forecast', settlementStage: 'third' },
    methodology: [
      'Real GDP is adjusted for inflation; base effects concern the comparison period.',
      'QoQ SAAR is quarterly growth at a seasonally adjusted annual rate. YoY forecasts are not converted into quarterly forecasts.',
      'GDPNow targets the advance estimate; an unconfirmed forecast release target remains unconfirmed.',
      'Later Hedgeye forecasts are Enhanced Comparative Base Effects Model outputs when identified as such in reviewed source evidence.',
      'Forecast comparisons describe differences in percentage points, not probabilities or trading recommendations.',
      'Above means strictly greater than the threshold; equality loses for YES on the contract’s specified published reading.',
    ],
  };
}

function createGdpResearchService(options = {}) {
  const clock = options.now || Date.now;
  const now = () => {
    const value = clock();
    const millis = value instanceof Date ? value.getTime() : Number(value);
    if (!Number.isFinite(millis)) throw new Error('GDP research clock is invalid.');
    return millis;
  };
  const fetchText = options.fetchText || defaultFetchText;
  const fetchBinary = options.fetchBinary || (async (url) => Buffer.from((await axios.get(url, { timeout: 15_000, responseType: 'arraybuffer', maxContentLength: 20 * 1024 * 1024 })).data));
  const fetchJson = options.fetchJson || (async (url) => (await axios.get(url, { timeout: 15_000, maxContentLength: 10 * 1024 * 1024 })).data);
  const store = options.store || createGdpRecordStore({
    ...(options.filePath !== undefined ? { filePath: options.filePath } : {}),
    initialRecords: options.initialRecords === undefined ? [...references.records, reviewedHedgeyeReference, reviewedHedgeyeQ4Reference, ...historicalReferences.records] : options.initialRecords,
  });
  const quarter = options.quarter || DEFAULT_QUARTER;
  const ttlMs = options.ttlMs ?? 60 * 60_000;
  const retryMs = options.retryMs ?? 5 * 60_000;
  let nextRefreshAt = 0;
  let pending = null;
  let sourceStatus = [];

  async function refresh() {
    const verifiedAt = new Date(now()).toISOString();
    const loaders = [
      { id: 'bea_schedule', url: BEA_SCHEDULE_URL, run: async () => {
        const records = parseBeaSchedule(await fetchText(BEA_SCHEDULE_URL), { verifiedAt });
        if (!records.length) throw new Error('No verified BEA schedule records.');
        return records;
      } },
      { id: 'bea_readings', url: BEA_GDP_URL, run: async () => {
        const html = await fetchText(BEA_GDP_URL);
        const links = beaReleaseLinks(html);
        if (!links.length) throw new Error('BEA release identity unavailable.');
        const results = await Promise.allSettled(links.slice(0, 6).map(async (sourceUrl) => parseBeaReading(await fetchText(sourceUrl), { verifiedAt, sourceUrl })));
        const records = results.flatMap((result) => result.status === 'fulfilled' && result.value ? [result.value] : []);
        if (!records.length) throw new Error('No verified BEA reading records.');
        return records;
      } },
      { id: 'gdpnow', url: GDPNOW_URL, run: async () => {
        const record = parseGdpNow(await fetchText(GDPNOW_URL), { verifiedAt });
        if (!record) throw new Error('No dated GDPNow headline.');
        return [record];
      } },
    ];
    const results = await Promise.allSettled(loaders.map((loader) => loader.run()));
    sourceStatus = results.map((result, index) => ({
      id: loaders[index].id, sourceUrl: loaders[index].url, checkedAt: verifiedAt,
      status: result.status === 'fulfilled' ? 'verified' : 'unavailable',
      ...(result.status === 'fulfilled' ? { lastSuccessAt: verifiedAt } : {}),
    }));
    for (const result of results) if (result.status === 'fulfilled') store.append(result.value);
    nextRefreshAt = now() + (results.some((result) => result.status === 'rejected') ? retryMs : ttlMs);
  }

  // Larger historical workbooks have a separate daily refresh and retain every
  // verified vintage. Current release and quote refreshes keep their own cadence.
  let nextHistoryRefreshAt = 0;
  let historyPending = null;
  function refreshHistory() {
    if (now() < nextHistoryRefreshAt || historyPending) return;
    nextHistoryRefreshAt = now() + 24 * 60 * 60_000;
    const verifiedAt = new Date(now()).toISOString();
    const minQuarter = `${new Date(now()).getUTCFullYear() - 1}-Q1`;
    historyPending = Promise.allSettled([
      (async () => loadBeaHistory({ html: await fetchText(BEA_GDP_URL), verifiedAt, minQuarter, fetchBinary, fetchJson, existingRecords: store.read() }))(),
      (async () => loadGdpNowHistory({ html: await fetchText(GDPNOW_URL), verifiedAt, minQuarter, fetchBinary }))(),
    ]).then((results) => {
      for (const result of results) if (result.status === 'fulfilled') store.append(result.value);
      if (results.some((result) => result.status === 'rejected')) nextHistoryRefreshAt = now() + retryMs;
    }).finally(() => { historyPending = null; });
  }

  async function getSnapshot({ refresh: force = false } = {}) {
    if ((force || now() >= nextRefreshAt) && !pending) pending = refresh().finally(() => { pending = null; });
    if (pending) await pending;
    if (options.historyRefresh !== false && !options.fetchText) refreshHistory();
    return snapshotFromRecords(store.read(), quarter, { now: now(), sourceStatus });
  }
  return { getSnapshot, store };
}

module.exports = {
  DEFAULT_QUARTER, BEA_SCHEDULE_URL, BEA_GDP_URL, GDPNOW_URL, quarterBounds, plainText,
  parseBeaSchedule, parseBeaReading, parseGdpNow, beaReleaseLinks, snapshotFromRecords, createGdpResearchService,
};
