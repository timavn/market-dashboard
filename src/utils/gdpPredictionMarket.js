import releaseNotices from '../../data/research/gdp/release-notices.json';

export const GDP_SELECTED_QUARTER = '2026-Q3';
export const GDP_UNIT = 'percent_qoq_saar';
export const GDP_RULES_URL = 'https://data.forecastex.com/regulatory/RGDPTermsandConditions.pdf';
export const GDP_READING_STAGES = Object.freeze([
  { stage: 'advance', label: 'First reading', officialLabel: 'Advance' },
  { stage: 'second', label: 'First revision', officialLabel: 'Second estimate' },
  { stage: 'third', label: 'Second revision', officialLabel: 'Third estimate' },
]);

const UNSAFE_SOURCE = /mock|seed|fixture|fallback|cache|portfolio|cost.?basis|delayed|frozen|stale|offline|disconnect|synthetic|inferred|derived/i;
const UNSAFE_FLAGS = ['refreshFailed', 'fromCache', 'cachedOnly', 'cacheOnly', 'seeded', 'mock', 'isMock', 'stale', 'isStale', 'offline', 'disconnected', 'synthetic', 'referenceOnly'];
export const gdpNumber = (value) => value !== '' && value !== null && value !== undefined
  && typeof value !== 'boolean' && Number.isFinite(Number(value)) ? Number(value) : null;

export const gdpSourceUrl = (value, hostname = null) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (!hostname || url.hostname === hostname || url.hostname.endsWith(`.${hostname}`))
      ? url.href : null;
  } catch { return null; }
};

const dated = (value, nowMs) => Number.isFinite(Date.parse(value || '')) && Date.parse(value) <= nowMs;
const safeRecord = (record) => record && !UNSAFE_FLAGS.some((flag) => record[flag] === true)
  && record.connected !== false && !/offline|error|disconnected|stale|unavailable/i.test(String(record.status || ''))
  && !UNSAFE_SOURCE.test([record.source, record.provenance, record.dataType, record.providerStatus].filter(Boolean).join(' '));
const matchingUnit = (record, inheritedUnit) => (record?.unit || inheritedUnit) === GDP_UNIT;

export const selectGdpForecasts = (records, quarter, nowMs = Date.now()) => (Array.isArray(records) ? records : [])
  .filter((row) => row.quarter === quarter && row.unit === GDP_UNIT && gdpNumber(row.value) !== null
    && !row.mock && !row.seeded && !row.synthetic && !row.seed
    && (!row.metric || ['real_gdp', 'U.S. real GDP'].includes(row.metric))
    && dated(row.publishedAt, nowMs) && gdpSourceUrl(row.sourceUrl) && row.modelType
    && ['hedgeye', 'gdpnow', 'consensus'].includes(row.sourceId)
    && (row.sourceId === 'gdpnow'
      ? gdpSourceUrl(row.sourceUrl, 'atlantafed.org') && row.targetStage === 'advance'
      : dated(row.reviewedAt, nowMs)))
  .sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt)
    || (Date.parse(right.verifiedAt || '') || 0) - (Date.parse(left.verifiedAt || '') || 0));

export const selectGdpReadings = (records, quarter, unit = GDP_UNIT, nowMs = Date.now()) => (Array.isArray(records) ? records : [])
  .filter((row) => row.quarter === quarter && matchingUnit(row, unit)
    && ['advance', 'second', 'third', 'initial', 'updated', 'annual'].includes(row.stage)
    && !row.mock && !row.seeded && !row.synthetic && !row.seed
    && (!row.metric || ['real_gdp', 'U.S. real GDP'].includes(row.metric))
    && gdpNumber(row.value) !== null && dated(row.releasedAt, nowMs) && gdpSourceUrl(row.sourceUrl, 'bea.gov'))
  .sort((left, right) => Date.parse(right.releasedAt) - Date.parse(left.releasedAt)
    || (Date.parse(right.verifiedAt || '') || 0) - (Date.parse(left.verifiedAt || '') || 0));

// These are dated research forecasts, separate from BEA publication history.
export function selectGdpQuarterEstimates(records, firstQuarter, nowMs = Date.now()) {
  const match = /^(\d{4})-Q([1-4])$/.exec(firstQuarter || '');
  if (!match) return [];
  const start = Number(match[1]) * 4 + Number(match[2]) - 1;
  return [start, start + 1].map((index) => {
    const quarter = `${Math.floor(index / 4)}-Q${index % 4 + 1}`;
    const forecast = selectGdpForecasts(records, quarter, nowMs).find((row) => row.sourceId === 'hedgeye'
      && gdpSourceUrl(row.sourceUrl, 'hedgeye.com') && dated(row.verifiedAt, nowMs)
      && Date.parse(row.reviewedAt) >= Date.parse(row.publishedAt)
      && Date.parse(row.verifiedAt) >= Date.parse(row.publishedAt)
      && (!row.kind || row.kind === 'forecast') && !row.isMock
      && !/mock|seed|fixture|synthetic|inferred/i.test(String(row.provenance || '')));
    return { quarter, forecast: forecast ? { ...forecast, value: gdpNumber(forecast.value) } : null };
  });
}

export const selectGdpSchedule = (records, quarter) => GDP_READING_STAGES.map((definition) => ({
  ...definition,
  ...(Array.isArray(records) ? records : []).find((row) => row.stage === definition.stage
    && (!row.quarter || row.quarter === quarter)
    && Number.isFinite(Date.parse(row.releaseAt || '')) && gdpSourceUrl(row.sourceUrl, 'bea.gov')),
}));

export const gdpThresholdGap = (threshold, forecast) => {
  const strike = gdpNumber(threshold);
  const point = gdpNumber(forecast);
  return strike === null || point === null ? null : Number((strike - point).toFixed(8));
};

export const gdpQuarterLabel = (quarter) => {
  const match = /^(\d{4})-Q([1-4])$/.exec(quarter || '');
  return match ? `Q${match[2]} ${match[1]} · ${['January–March', 'April–June', 'July–September', 'October–December'][Number(match[2]) - 1]}` : 'GDP';
};

const generationFor = (quarter) => {
  const match = /^(\d{4})-Q([1-4])$/.exec(quarter || '');
  return match ? `RGDP_Q${match[2]}${match[1].slice(-2)}` : null;
};

export const isGdpContractIdentity = (event, quarter) => {
  const generation = generationFor(quarter);
  return Boolean(generation && event?.measuredQuarter === quarter && event.settlementStage === 'third'
    && event.productCode === 'RGDP' && (event.generationId || event.ticker) === generation
    && (!event.unit || event.unit === GDP_UNIT)
    && event.rulesUrl === GDP_RULES_URL
    && Number.isFinite(Date.parse(event.resolutionAt || '')));
};

export const buildGdpContractRows = (snapshot, quarter, nowMs = Date.now()) => {
  const book = snapshot?.contracts || snapshot?.venues?.forecastex?.book;
  const catalog = snapshot?.venues?.forecastex?.catalog;
  const hasCatalogThresholds = safeRecord(catalog) && catalog.status === 'available'
    && catalog.source === 'forecastex_official_contracts' && dated(catalog.asOf, nowMs + 5000)
    && Array.isArray(catalog.thresholds) && isGdpContractIdentity(catalog.event, quarter);
  const display = hasCatalogThresholds ? catalog : snapshot?.displayContracts || book;
  const event = display?.event || book?.event;
  if (!isGdpContractIdentity(event, quarter)) return { event: null, rows: [], live: false, asOf: null };
  const quoteKeys = ['yesBid', 'yesAsk', 'noBid', 'noAsk'];
  const nativeSource = (value) => /ibkr/i.test(String(value || '')) && !UNSAFE_SOURCE.test(String(value || ''));
  const fresh = (value, expiresAt) => dated(value, nowMs + 5000) && nowMs - Date.parse(value) <= 90_000
    && Number.isFinite(Date.parse(expiresAt || '')) && nowMs < Date.parse(expiresAt);
  const bookUsable = safeRecord(snapshot) && safeRecord(book) && ['available', 'partial', 'live'].includes(book?.status)
    && nativeSource(book.source) && isGdpContractIdentity(book.event, quarter)
    && fresh(book.asOf, book.bookExpiresAt || book.expiresAt)
    && Number.isFinite(Date.parse(event.closeTime || '')) && Date.parse(event.closeTime) > nowMs;
  const nativeRows = new Map((book?.lines || []).map((line) => [line.contractId || line.ticker, line]));
  const generation = generationFor(quarter);
  const rows = (hasCatalogThresholds ? catalog.thresholds : display?.lines || []).filter((line) => {
    const identity = String(line.contractId || line.ticker || '');
    return identity === `${generation}_${gdpNumber(line.threshold)}` && gdpNumber(line.threshold) !== null
      && (!hasCatalogThresholds || safeRecord(line))
      && ['>', 'above'].includes(line.comparator)
      && (!line.measuredQuarter || line.measuredQuarter === quarter)
      && (!line.unit || line.unit === GDP_UNIT);
  }).map((line) => {
    const native = nativeRows.get(line.contractId || line.ticker);
    const live = bookUsable && safeRecord(native) && native.directNative === true
      && (native.threshold === undefined || gdpNumber(native.threshold) === gdpNumber(line.threshold))
      && nativeSource(native.source || native.provenance || book.source)
      && (!native.derivedFields || native.derivedFields.length === 0)
      && fresh(native.updatedAt || native.asOf || book.asOf, native.expiresAt || book.expiresAt)
      && (!native.dataType || native.dataType === 'live');
    const row = { ...line, live: false };
    quoteKeys.forEach((key) => {
      const price = live ? gdpNumber(native[key]) : null;
      row[key] = price !== null && price >= 0 && price <= 1 ? price : null;
      const size = row[key] !== null ? gdpNumber(native[`${key}Size`]) : null;
      row[`${key}Size`] = size !== null && size >= 0 ? size : null;
    });
    row.live = quoteKeys.some((key) => row[key] !== null);
    row.updatedAt = row.live ? native.updatedAt || native.asOf || book.asOf : null;
    // Activity is displayed only from the same fresh native response; catalog
    // activity requires its own dated provenance and is not an executable quote.
    ['volume24h', 'volume', 'openInterest'].forEach((key) => {
      const nativeValue = live ? gdpNumber(native[key]) : null;
      const catalogValue = safeRecord(line) && gdpSourceUrl(line.activitySourceUrl, 'forecastex.com')
        && dated(line.activityAsOf, nowMs) ? gdpNumber(line[key]) : null;
      const value = nativeValue ?? catalogValue;
      row[key] = value !== null && value >= 0 ? value : null;
    });
    return row;
  }).sort((left, right) => left.threshold - right.threshold);
  return { event, rows, live: rows.some((row) => row.live), asOf: bookUsable ? book.asOf : null };
};

export const GDP_HISTORY_STAGES = { advance: '1st', second: '2nd', third: '3rd', initial: 'Initial', updated: 'Updated', annual: 'Annual update' };
export const GDP_COMPONENTS = [
  { id: 'consumption', label: 'Consumer spending' }, { id: 'fixedInvestment', label: 'Fixed investment' },
  { id: 'inventories', label: 'Inventories' }, { id: 'netExports', label: 'Net exports' }, { id: 'government', label: 'Government' },
];
export const gdpReadingKey = (row) => `${row.quarter}:${row.stage}:${row.releasedAt?.slice(0, 10)}`;
export const gdpShortQuarter = (quarter) => /^\d{4}-Q[1-4]$/.test(quarter || '') ? quarter.replace(/(\d{4})-Q(\d)/, 'Q$2 $1') : '—';
export const gdpSigned = (value, digits = 1) => gdpNumber(value) === null ? '—' : `${Number(value) > 0 ? '+' : ''}${Number(value).toFixed(digits)}`;

export function buildGdpReleaseHistory(research, nowMs = Date.now()) {
  const records = [...(research.readingHistory || []), ...(research.readings || []), ...(research.priorQuarter?.readings || [])];
  const quarters = [...new Set(records.map((r) => r.quarter))];
  const all = quarters.flatMap((q) => selectGdpReadings(records, q, GDP_UNIT, nowMs));
  const unique = new Map();
  // Latest verification of the same publication wins for display; the ledger retains both.
  all.sort((a, b) => (Date.parse(b.verifiedAt) || 0) - (Date.parse(a.verifiedAt) || 0)
    || Date.parse(b.releasedAt) - Date.parse(a.releasedAt)).forEach((r) => {
    if (!unique.has(gdpReadingKey(r))) unique.set(gdpReadingKey(r), { ...r, key: gdpReadingKey(r) });
  });
  const readings = [...unique.values()].sort((a, b) => Date.parse(a.releasedAt) - Date.parse(b.releasedAt) || a.quarter.localeCompare(b.quarter));
  const end = new Date(nowMs);
  const currentMonth = end.toISOString().slice(0, 7);
  if (!readings.some((r) => r.releasedAt.startsWith(currentMonth))) end.setUTCMonth(end.getUTCMonth() - 1, 1);
  const months = Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 11 + i, 1)).toISOString().slice(0, 7));
  const publicationQuarters = new Set(readings.filter((r) => r.stage !== 'annual' && months.includes(r.releasedAt.slice(0, 7))).map((r) => r.quarter));
  // An annual update to a quarter outside this release window belongs in the
  // retained source history, not alongside this year's first/second/third cycle.
  // Complete the release cycle at the window boundary, rather than orphaning a
  // third reading and hiding its first two publications.
  const visible = readings.filter((r) => publicationQuarters.has(r.quarter));
  const latest = new Map();
  const first = new Map();
  readings.forEach((r) => {
    latest.set(r.quarter, r);
    if (['advance', 'initial'].includes(r.stage) && !first.has(r.quarter)) first.set(r.quarter, r);
  });
  const displayed = visible.map((r) => ({ ...r, latest: latest.get(r.quarter)?.key === r.key }));
  const schedules = [...(research.scheduleHistory || []),
    ...(research.priorQuarter?.schedule || []).map((r) => ({ ...r, quarter: r.quarter || research.priorQuarter.quarter })),
    ...(research.schedule || []).map((r) => ({ ...r, quarter: r.quarter || research.quarter }))];
  const groups = [...publicationQuarters].sort().map((quarter) => {
    const members = displayed.filter((r) => r.quarter === quarter);
    const exceptional = members.some((r) => ['initial', 'updated'].includes(r.stage));
    // Initial/Updated are a different official publication cycle, not fabricated
    // advance/second/third readings. Keep those labels and every real vintage.
    const slots = exceptional ? members.map((reading) => ({ reading, stage: reading.stage }))
      : GDP_READING_STAGES.flatMap(({ stage }) => {
        const publications = members.filter((r) => r.stage === stage);
        if (publications.length) return publications.map((reading) => ({ reading, stage }));
        const scheduled = schedules.filter((r) => r.quarter === quarter && r.stage === stage
          && Number.isFinite(Date.parse(r.releaseAt)) && gdpSourceUrl(r.sourceUrl, 'bea.gov'))
          .sort((a, b) => (Date.parse(b.verifiedAt) || 0) - (Date.parse(a.verifiedAt) || 0))[0];
        return [{ stage, reading: null, scheduled, pending: scheduled ? Date.parse(scheduled.releaseAt) > nowMs : false }];
      }).concat(members.filter((r) => r.stage === 'annual').map((reading) => ({ reading, stage: reading.stage })));
    const notice = releaseNotices.find((r) => r.quarter === quarter && dated(r.publishedAt, nowMs)
      && dated(r.verifiedAt, nowMs) && gdpSourceUrl(r.sourceUrl, 'bea.gov'));
    return { quarter, slots, notice };
  });
  const dates = [...displayed.map((r) => r.releasedAt), ...groups.flatMap((g) => g.slots.map((s) => s.scheduled?.releaseAt))].filter(Boolean).sort();
  return { readings, visible: displayed, months, groups, latest, first, rangeStart: dates[0], rangeEnd: dates.at(-1) };
}

const targetMatches = (target, stage) => target === stage || (target === 'advance' && stage === 'initial');
export function selectGdpPreReleaseForecasts(records, reading, nowMs = Date.now()) {
  if (!reading) return [];
  const beforeRelease = (r) => r.publishedAt.length === 10 || reading.releasedAt.length === 10
    ? r.publishedAt.slice(0, 10) < reading.releasedAt.slice(0, 10)
    : Date.parse(r.publishedAt) < Date.parse(reading.releasedAt);
  const candidates = selectGdpForecasts(records, reading.quarter, nowMs).filter(beforeRelease);
  return ['consensus', 'gdpnow', 'hedgeye'].flatMap((id) => {
    const source = candidates.filter((r) => r.sourceId === id);
    const record = source.find((r) => targetMatches(r.targetStage, reading.stage)) || source.find((r) => r.targetStage == null) || source[0];
    return record ? [{ ...record, matchedTarget: targetMatches(record.targetStage, reading.stage),
      gap: targetMatches(record.targetStage, reading.stage) ? gdpThresholdGap(reading.value, record.value) : null }] : [];
  });
}

export function buildGdpComponentComparison(records, first, latest, nowMs = Date.now()) {
  const select = (reading) => reading && (records || []).filter((r) => r.quarter === reading.quarter
    && r.stage === reading.stage && r.releasedAt?.slice(0, 10) === reading.releasedAt.slice(0, 10)
    && r.unit === 'percentage_points' && r.metric === 'U.S. real GDP' && r.sourceId === 'bea'
    && dated(r.releasedAt, nowMs) && dated(r.verifiedAt, nowMs) && gdpSourceUrl(r.sourceUrl, 'bea.gov')
    && !r.mock && !r.seeded && !r.synthetic)
    .sort((a, b) => Date.parse(b.verifiedAt) - Date.parse(a.verifiedAt))[0];
  const initial = select(first);
  const current = select(latest);
  const revised = first && latest && first.key !== latest.key;
  return { first: initial, latest: current, rows: GDP_COMPONENTS.map((component) => {
    const a = gdpNumber(initial?.values?.[component.id]);
    const b = gdpNumber(current?.values?.[component.id]);
    return { ...component, first: a, latest: b, revision: revised ? gdpThresholdGap(b, a) : null };
  }) };
}

export function selectGdpNearbyContracts(rows, forecast, count = 6) {
  if (rows.length <= count) return rows;
  const value = gdpNumber(forecast);
  if (value === null) return rows.slice(Math.max(0, rows.findIndex((r) => r.threshold >= 0)), Math.max(0, rows.findIndex((r) => r.threshold >= 0)) + count);
  const nearest = rows.reduce((best, r, i) => Math.abs(r.threshold - value) < Math.abs(rows[best].threshold - value) ? i : best, 0);
  const start = Math.max(0, Math.min(rows.length - count, nearest - Math.floor(count / 2)));
  return rows.slice(start, start + count);
}
