const crypto = require('crypto');
const { readWorkbookOffThread: readWorkbook } = require('../workbookReaderWorkerService.cjs');
const { GDP_METRIC, GDP_UNIT, normalizeGdpRecord } = require('./gdpResearchRecords.cjs');

const BEA_ARCHIVE = 'https://apps.bea.gov/histdata/core/data/Fea_DisplayChildrenC/';
const COMPONENT_CODES = { consumption: 'DPCERY', fixedInvestment: 'A007RY', inventories: 'A014RY', netExports: 'A019RY', government: 'A822RY' };
const meta = (buffer, sourceUrl, verifiedAt) => ({ sourceUrl, verifiedAt, evidenceSha256: crypto.createHash('sha256').update(buffer).digest('hex') });
const isoDay = (value) => {
  const millis = value instanceof Date ? value.getTime() : Date.parse(value || '');
  return Number.isFinite(millis) ? new Date(millis).toISOString().slice(0, 10) : null;
};
const base = { sourceId: 'bea', metric: GDP_METRIC, unit: GDP_UNIT };

// Read publication vintages, never the revised historical series in today's NIPA table.
function parseBeaVintages(sheets, evidence, minQuarter) {
  const sheet = sheets.find((s) => s.sheet === 'Vintage History');
  if (!sheet || !String(sheet.data[0]?.[0]).includes('Vintage History of Quarterly Gross Domestic Product')) return [];
  if (!sheet.data.some((r) => r[4] === 'Real GDP' && r[6] === 'Release Date')) return [];
  let quarter = null;
  const records = [];
  for (const row of sheet.data) {
    if (/^20\d{2}Q[1-4]$/.test(row[0])) quarter = row[0].replace('Q', '-Q');
    if (!quarter || quarter < minQuarter) continue;
    const vintage = String(row[1] || '').toLowerCase();
    const stage = ['advance', 'second', 'third', 'initial', 'updated'].includes(vintage) ? vintage : vintage === 'revised' ? 'annual' : null;
    // GDI-only publications are not new GDP readings.
    if (!stage || /GDP not (?:open for revision|revised)/i.test(row[6])) continue;
    const match = String(row[6] || '').match(/^([A-Za-z]+ \d{1,2}, 20\d{2})/);
    const releasedAt = match && isoDay(match[1]);
    const value = row[4] === null || row[4] === '' ? NaN : Number(row[4]);
    if (!releasedAt || releasedAt > evidence.verifiedAt.slice(0, 10) || !Number.isFinite(value)) continue;
    records.push(normalizeGdpRecord({ ...base, ...evidence, kind: 'reading', quarter, stage, value, releasedAt }));
  }
  return records;
}

function parseGdpNowArchives(sheets, evidence, minQuarter) {
  const sheet = sheets.find((s) => s.sheet === 'TrackingArchives');
  if (!sheet) return [];
  const headers = sheet.data[0];
  const forecastIndex = headers.indexOf('GDP Nowcast');
  if (headers[0] !== 'Forecast Date' || headers[1] !== 'Quarter being forecasted' || forecastIndex < 0) return [];
  return sheet.data.slice(1).flatMap((row) => {
    const day = isoDay(row[0]);
    const period = row[1] instanceof Date ? row[1] : new Date(row[1]);
    if (!day || !Number.isFinite(period.getTime()) || day > evidence.verifiedAt.slice(0, 10)) return [];
    const quarter = `${period.getUTCFullYear()}-Q${Math.floor(period.getUTCMonth() / 3) + 1}`;
    if (quarter < minQuarter || typeof row[forecastIndex] !== 'number' || !Number.isFinite(row[forecastIndex])) return [];
    return [normalizeGdpRecord({ ...evidence, kind: 'forecast', sourceId: 'gdpnow', metric: GDP_METRIC, unit: GDP_UNIT,
      quarter, publishedAt: day, value: Number(row[forecastIndex].toFixed(1)), targetStage: 'advance',
      modelType: 'GDPNow statistical nowcast', evidence: 'Atlanta Fed TrackingArchives: dated GDP Nowcast, rounded to the published headline precision of one decimal percent. Excludes pseudo-real-time model reconstructions.' })];
  });
}

function parseBeaComponents(sheets, reading, evidence) {
  const sheet = sheets.find((s) => s.sheet === 'T10102-Q');
  if (!sheet || !String(sheet.data[0]?.[0]).startsWith('Table 1.1.2. Contributions to Percent Change in Real Gross Domestic Product')
    || !sheet.data.some((r) => /Seasonally adjusted at annual rates/.test(r[0]))) return null;
  const publication = sheet.data.find((r) => /^Data published /.test(r[0]));
  const day = isoDay(String(publication?.[0] || '').replace('Data published ', ''));
  if (!day || day !== reading.releasedAt.slice(0, 10)) return null;
  const header = sheet.data.find((r) => r[0] === 'Line');
  const column = header?.indexOf(reading.quarter.replace('-', '')) ?? -1;
  if (column < 0) return null;
  const gdp = sheet.data.find((r) => r[2] === 'A191RL')?.[column];
  if (typeof gdp !== 'number' || Math.abs(gdp - reading.value) > 0.051) return null;
  const values = Object.fromEntries(Object.entries(COMPONENT_CODES).map(([key, code]) => [key, sheet.data.find((r) => r[2] === code)?.[column]]));
  if (!Object.values(values).every((value) => typeof value === 'number' && Number.isFinite(value))) return null;
  // Five disjoint contributions should reconcile to headline growth within published rounding.
  if (Math.abs(Object.values(values).reduce((a, b) => a + b, 0) - gdp) > 0.08) return null;
  return normalizeGdpRecord({ ...base, ...evidence, kind: 'components', unit: 'percentage_points',
    quarter: reading.quarter, stage: reading.stage, releasedAt: reading.releasedAt, values });
}

function sourceWorkbookLink(html, pattern, baseUrl, allowedHost) {
  for (const match of String(html).matchAll(/href=["']([^"']+)["']/g)) {
    if (!pattern.test(match[1])) continue;
    try {
      const url = new URL(match[1].replaceAll('&amp;', '&'), baseUrl);
      if (url.protocol === 'https:' && url.hostname === allowedHost) return url.href;
    } catch { /* Ignore malformed source links. */ }
  }
  return null;
}

async function loadBeaHistory({ html, verifiedAt, minQuarter, fetchBinary, fetchJson, existingRecords = [] }) {
  const sourceUrl = sourceWorkbookLink(html, /gdp-gdi-vintage-history\.xlsx/, 'https://www.bea.gov', 'www.bea.gov');
  if (!sourceUrl) return [];
  const buffer = await fetchBinary(sourceUrl);
  const readings = parseBeaVintages(await readWorkbook(buffer), meta(buffer, sourceUrl, verifiedAt), minQuarter);
  const missing = readings.filter((r) => r.stage !== 'annual' && !existingRecords.some((c) => c.kind === 'components'
    && c.quarter === r.quarter && c.stage === r.stage && c.releasedAt.slice(0, 10) === r.releasedAt.slice(0, 10)));
  if (!missing.length) return readings;
  // Archive downtime must not hide the independently verified GDP readings.
  let folders;
  try { folders = (await fetchJson(`${BEA_ARCHIVE}?HistMainId=7&getFiles=false&getDirs=true`)).FileArray; } catch { return readings; }
  if (!Array.isArray(folders)) return readings;
  const components = [];
  for (let i = 0; i < missing.length; i += 4) {
    const results = await Promise.allSettled(missing.slice(i, i + 4).map(async (reading) => {
      const [year, quarter] = reading.quarter.split('-');
      const candidates = folders.filter((folder) => folder.includes(`\\${year}\\${quarter}\\`)
        && folder.split('\\').at(-1).toLowerCase().startsWith(`${reading.stage}_`));
      if (candidates.length !== 1) return null;
      const url = `${BEA_ARCHIVE}?${new URLSearchParams({ HistMainId: '7', thePath: candidates[0], getFiles: 'true', getDirs: 'false' })}`;
      const files = await fetchJson(url);
      const file = (files.Filearray3 || []).find((p) => /\\Section1all_xls\.xlsx$/.test(p));
      const prefix = '/Inetpub/wwwroot/website/website/HistData/';
      if (!file?.startsWith(prefix)) return null;
      const fileUrl = new URL(file.slice(prefix.length).replaceAll('\\', '/'), 'https://apps.bea.gov/HistData/').href;
      if (!fileUrl.startsWith('https://apps.bea.gov/HistData/Files/Releases/GDP_and_PI/')) return null;
      const data = await fetchBinary(fileUrl);
      return parseBeaComponents(await readWorkbook(data), reading, meta(data, fileUrl, verifiedAt));
    }));
    components.push(...results.flatMap((r) => r.status === 'fulfilled' && r.value ? [r.value] : []));
  }
  return [...readings, ...components];
}

async function loadGdpNowHistory({ html, verifiedAt, minQuarter, fetchBinary }) {
  const sourceUrl = sourceWorkbookLink(html, /GDPTrackingModelDataAndForecasts\.xlsx/, 'https://www.atlantafed.org', 'www.atlantafed.org');
  if (!sourceUrl) return [];
  const buffer = await fetchBinary(sourceUrl);
  return parseGdpNowArchives(await readWorkbook(buffer), meta(buffer, sourceUrl, verifiedAt), minQuarter);
}

module.exports = { parseBeaVintages, parseBeaComponents, parseGdpNowArchives, loadBeaHistory, loadGdpNowHistory, sourceWorkbookLink };
