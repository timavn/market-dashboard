const fs = require('fs');
const path = require('path');
const {
  DEFAULT_GDP_LAG_MONTHS,
  GLOBAL_LIQUIDITY_RATIO_PRESSURE_WEIGHTS,
  GLOBAL_LIQUIDITY_REGIME_THRESHOLDS,
  GLOBAL_LIQUIDITY_SCORE_BREAKPOINTS,
  GLOBAL_LIQUIDITY_WEIGHTS,
  NET_LIQUIDITY_DIRECTION_TOLERANCE,
  NET_LIQUIDITY_MAX_AGE_DAYS,
  NET_LIQUIDITY_WINDOWS_WEEKS,
  US_LIQUIDITY_ACCELERATION_TOLERANCE,
  US_LIQUIDITY_GREEN_STACK_TO_GDP,
} = require('../constants/liquidityModelMetadata.cjs');

const DEFAULT_START_DATE = '2000-01-01';
const HISTORY_LIMIT = 180;
let defaultAxiosClient;

function getDefaultAxiosClient() {
  if (!defaultAxiosClient) defaultAxiosClient = require('axios');
  return defaultAxiosClient;
}

const GLOBAL_COUNTRIES = [
  {
    code: 'us',
    name: 'United States',
    m2: { kind: 'fred', seriesId: 'M2SL', label: 'U.S. M2', monthlyMethod: 'last' },
    gdp: { kind: 'fred', seriesId: 'GDP', label: 'U.S. nominal GDP', monthlyMethod: 'last', alignment: 'no_lookahead' },
    fx: { kind: 'constant', value: 1, label: 'USD FX' },
  },
  {
    code: 'eurozone',
    name: 'Eurozone',
    m2: { kind: 'fred', seriesId: 'MYAGM2EZM196N', label: 'Eurozone M2', monthlyMethod: 'last' },
    gdp: { kind: 'csv', path: 'data/liquidity/eurozone_nominal_gdp.csv', label: 'Eurozone nominal GDP', monthlyMethod: 'last', alignment: 'no_lookahead' },
    fx: { kind: 'fred', seriesId: 'DEXUSEU', label: 'EUR/USD FX', monthlyMethod: 'average' },
  },
  {
    code: 'japan',
    name: 'Japan',
    m2: { kind: 'fred', seriesId: 'MYAGM2JPM189N', label: 'Japan M2', monthlyMethod: 'last' },
    gdp: { kind: 'csv', path: 'data/liquidity/japan_nominal_gdp.csv', label: 'Japan nominal GDP', monthlyMethod: 'last', alignment: 'no_lookahead' },
    fx: { kind: 'fred', seriesId: 'DEXJPUS', label: 'JPY/USD FX', monthlyMethod: 'average', transform: 'inverse' },
  },
  {
    code: 'uk',
    name: 'United Kingdom',
    m2: { kind: 'csv', path: 'data/liquidity/uk_broad_money.csv', label: 'UK broad money', monthlyMethod: 'last' },
    gdp: { kind: 'csv', path: 'data/liquidity/uk_nominal_gdp.csv', label: 'UK nominal GDP', monthlyMethod: 'last', alignment: 'no_lookahead' },
    fx: { kind: 'fred', seriesId: 'DEXUSUK', label: 'GBP/USD FX', monthlyMethod: 'average' },
  },
  {
    code: 'china',
    name: 'China',
    m2: { kind: 'fred', seriesId: 'MYAGM2CNM189N', label: 'China M2', monthlyMethod: 'last' },
    gdp: { kind: 'csv', path: 'data/liquidity/china_nominal_gdp.csv', label: 'China nominal GDP', monthlyMethod: 'last', alignment: 'no_lookahead' },
    fx: { kind: 'fred', seriesId: 'DEXCHUS', label: 'CNY/USD FX', monthlyMethod: 'average', transform: 'inverse' },
  },
];

const US_STACK_CONFIG = {
  gdp: { kind: 'fred', seriesId: 'GDP', label: 'U.S. nominal GDP', monthlyMethod: 'last', alignment: 'no_lookahead' },
  components: [
    {
      code: 'bank_deposits',
      name: 'Bank deposits',
      source: { kind: 'fred', seriesId: 'DPSACBW027SBOG', label: 'Bank deposits', monthlyMethod: 'last' },
    },
    {
      code: 'retail_mmf',
      name: 'Retail MMF',
      source: { kind: 'fred', seriesId: 'RMFSL', label: 'Retail money market funds', monthlyMethod: 'last' },
    },
    {
      code: 'total_mmf',
      name: 'Total MMF',
      provisional: true,
      source: {
        kind: 'fred',
        seriesId: 'MMMFFAQ027S',
        label: 'Total money market funds',
        monthlyMethod: 'last',
        alignment: 'no_lookahead',
        scale: 0.001,
      },
    },
    {
      code: 'institutional_mmf',
      name: 'Institutional MMF',
      provisional: true,
      derived: { kind: 'subtract', left: 'total_mmf', right: 'retail_mmf', allowNegative: false },
    },
    {
      code: 'currency_in_circulation',
      name: 'Currency in circulation',
      source: {
        kind: 'fred',
        seriesId: 'WCURCIR',
        label: 'Currency in circulation',
        monthlyMethod: 'last',
        scale: 0.001,
      },
    },
  ],
};

// All three are reported in billions after scaling. WALCL and WTREGEN are
// Wednesday levels in millions; RRPONTSYD is a daily series in billions.
const NET_LIQUIDITY_CONFIG = {
  fedBalanceSheet: { kind: 'fred', seriesId: 'WALCL', label: 'Fed total assets', scale: 0.001 },
  treasuryGeneralAccount: { kind: 'fred', seriesId: 'WTREGEN', label: 'Treasury General Account', scale: 0.001 },
  reverseRepo: { kind: 'fred', seriesId: 'RRPONTSYD', label: 'Overnight reverse repo', scale: 1 },
};
const NET_LIQUIDITY_HISTORY_WEEKS = 156;
const DAY_MS = 24 * 60 * 60 * 1000;

function toMonthKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

function addMonths(monthKey, months) {
  const date = new Date(`${monthKey}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + months);
  return toMonthKey(date);
}

function monthRange(startKey, endKey) {
  if (!startKey || !endKey || startKey > endKey) return [];
  const keys = [];
  let cursor = startKey;
  while (cursor <= endKey) {
    keys.push(cursor);
    cursor = addMonths(cursor, 1);
  }
  return keys;
}

function sortSeries(series) {
  return (series || [])
    .map((point) => ({ date: toMonthKey(point.date), value: Number(point.value) }))
    .filter((point) => point.date && Number.isFinite(point.value))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function toMonthly(series, method = 'last') {
  const buckets = new Map();
  sortSeries(series).forEach((point) => {
    if (!buckets.has(point.date)) buckets.set(point.date, []);
    buckets.get(point.date).push(point.value);
  });

  return Array.from(buckets.entries()).map(([date, values]) => {
    let value;
    if (method === 'average') {
      value = values.reduce((sum, item) => sum + item, 0) / values.length;
    } else if (method === 'first') {
      value = values[0];
    } else if (method === 'last') {
      value = values[values.length - 1];
    } else {
      throw new Error(`Unsupported monthly method: ${method}`);
    }
    return { date, value };
  });
}

function alignNoLookahead(series, method = 'last', publicationLagMonths = DEFAULT_GDP_LAG_MONTHS, endDate = new Date()) {
  const monthly = toMonthly(series, method).map((point) => ({
    date: addMonths(point.date, publicationLagMonths),
    value: point.value,
  }));
  if (monthly.length === 0) return [];

  const endKey = toMonthKey(endDate);
  const index = monthRange(monthly[0].date, endKey);
  return forwardFill(monthly, index);
}

function forwardFill(series, index) {
  const sorted = sortSeries(series);
  const values = new Map(sorted.map((point) => [point.date, point.value]));
  let lastValue = null;
  return index.map((date) => {
    if (values.has(date)) lastValue = values.get(date);
    return { date, value: lastValue };
  }).filter((point) => Number.isFinite(point.value));
}

function annualizedRate(currentValue, priorValue, months) {
  if (months <= 0) throw new Error('months must be positive');
  if (!(currentValue > 0) || !(priorValue > 0)) return null;
  return Math.pow(currentValue / priorValue, 12 / months) - 1;
}

function withGrowthRows(rows, column, prefix) {
  const byDate = new Map(rows.map((row) => [row.date, row]));
  return rows.map((row) => {
    const next = { ...row };
    [1, 3, 6, 12].forEach((months) => {
      const prior = byDate.get(addMonths(row.date, -months));
      next[`${prefix}_${months}m_ann`] = prior ? annualizedRate(row[column], prior[column], months) : null;
    });
    return next;
  });
}

function latestComplete(rows, requiredColumns) {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (requiredColumns.every((column) => Number.isFinite(row[column]))) return row;
  }
  return null;
}

function linearScore(value, points) {
  if (!Number.isFinite(value)) return null;
  const sorted = [...points].sort((left, right) => left[0] - right[0]);
  if (value <= sorted[0][0]) return sorted[0][1];
  if (value >= sorted[sorted.length - 1][0]) return sorted[sorted.length - 1][1];

  for (let i = 0; i < sorted.length - 1; i += 1) {
    const [leftX, leftY] = sorted[i];
    const [rightX, rightY] = sorted[i + 1];
    if (value >= leftX && value <= rightX) {
      const span = rightX - leftX;
      if (span === 0) return rightY;
      const weight = (value - leftX) / span;
      return leftY + weight * (rightY - leftY);
    }
  }
  return null;
}

function growthRisk(value) {
  return linearScore(value, GLOBAL_LIQUIDITY_SCORE_BREAKPOINTS.growth);
}

function gapRisk(value) {
  return linearScore(value, GLOBAL_LIQUIDITY_SCORE_BREAKPOINTS.growthGap);
}

function ratioLevelRisk(value) {
  return linearScore(value, GLOBAL_LIQUIDITY_SCORE_BREAKPOINTS.ratioLevel);
}

function ratioTrendRisk(value) {
  return linearScore(value, GLOBAL_LIQUIDITY_SCORE_BREAKPOINTS.ratioTrend);
}

function weightedScore(parts) {
  let score = 0;
  let weightSum = 0;
  Object.entries(parts).forEach(([key, part]) => {
    if (Number.isFinite(part.value) && Number.isFinite(part.weight)) {
      score += part.value * part.weight;
      weightSum += part.weight;
    }
  });
  return weightSum > 0 ? score / weightSum : null;
}

function regimeLabel(score) {
  if (!Number.isFinite(score)) return 'unavailable';
  if (score < GLOBAL_LIQUIDITY_REGIME_THRESHOLDS.supportiveBelow) return 'supportive';
  if (score < GLOBAL_LIQUIDITY_REGIME_THRESHOLDS.neutralCautionBelow) return 'neutral/caution';
  if (score < GLOBAL_LIQUIDITY_REGIME_THRESHOLDS.yellowRiskBelow) return 'yellow risk';
  return 'red risk';
}

function accelerationLabel(
  shortRate,
  longRate,
  tolerance = US_LIQUIDITY_ACCELERATION_TOLERANCE,
) {
  if (!Number.isFinite(shortRate) || !Number.isFinite(longRate)) return 'unavailable';
  const spread = shortRate - longRate;
  if (spread > tolerance) return 'accelerating';
  if (spread < -tolerance) return 'decelerating';
  return 'stable';
}

function stackRegime(row) {
  const growth3m = row.stack_growth_3m_ann;
  const growth6m = row.stack_growth_6m_ann;
  const growth12m = row.stack_growth_12m_ann;
  const stackToGdp = row.stack_to_gdp;
  if (![growth3m, growth6m, growth12m, stackToGdp].every(Number.isFinite)) return 'unavailable';
  if (growth3m < 0 || growth6m < 0) return 'red risk';
  if (
    stackToGdp >= US_LIQUIDITY_GREEN_STACK_TO_GDP
    && growth3m > 0
    && growth6m > 0
    && growth12m > 0
  ) return 'green';
  return 'yellow';
}

function sourceMeta(source, status, error) {
  return {
    label: source.label || source.seriesId || source.path || source.kind,
    kind: source.kind,
    seriesId: source.seriesId || null,
    path: source.path || null,
    status,
    provisional: Boolean(source.provisional),
    error: error ? String(error.message || error) : null,
  };
}

async function fetchFredCsv(seriesId, axiosClient) {
  const client = axiosClient || getDefaultAxiosClient();
  const response = await client.get('https://fred.stlouisfed.org/graph/fredgraph.csv', {
    params: { id: seriesId },
    timeout: 20000,
    responseType: 'text',
  });
  const text = typeof response.data === 'string' ? response.data : String(response.data || '');
  return parseCsvSeries(text, 'DATE', seriesId);
}

function parseCsvSeries(text, dateColumn = 'DATE', valueColumn = 'VALUE') {
  const lines = String(text || '').trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]).map((header) => header.trim());
  const dateIndex = headers.indexOf(dateColumn) >= 0 ? headers.indexOf(dateColumn) : headers.indexOf('observation_date');
  const valueIndex = headers.indexOf(valueColumn);
  if (dateIndex < 0 || valueIndex < 0) {
    throw new Error(`CSV must include ${dateColumn} and ${valueColumn} columns`);
  }

  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const rawValue = cells[valueIndex];
    return {
      date: cells[dateIndex],
      value: rawValue === '.' || rawValue === '' ? null : Number(rawValue),
    };
  }).filter((point) => point.date && Number.isFinite(point.value));
}

function splitCsvLine(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];
    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

async function loadSource(source, options = {}) {
  const {
    baseDir = process.cwd(),
    axiosClient,
    now = new Date(),
    loadSeriesOverride,
  } = options;

  let rawSeries;
  if (loadSeriesOverride) {
    rawSeries = await loadSeriesOverride(source);
  } else if (source.kind === 'fred') {
    rawSeries = await fetchFredCsv(source.seriesId, axiosClient);
  } else if (source.kind === 'csv') {
    const csvPath = path.resolve(baseDir, source.path);
    if (!fs.existsSync(csvPath)) throw new Error(`Missing CSV source: ${source.path}`);
    rawSeries = parseCsvSeries(fs.readFileSync(csvPath, 'utf8'), source.dateColumn || 'DATE', source.valueColumn || 'VALUE');
  } else if (source.kind === 'constant') {
    rawSeries = monthRange('1900-01-01', toMonthKey(now)).map((date) => ({ date, value: source.value }));
  } else {
    throw new Error(`Unsupported source kind: ${source.kind}`);
  }

  const scale = source.scale == null ? 1 : Number(source.scale);
  const transformed = sortSeries(rawSeries).map((point) => {
    const scaled = point.value * scale;
    return {
      date: point.date,
      value: source.transform === 'inverse' ? 1 / scaled : scaled,
    };
  }).filter((point) => Number.isFinite(point.value));

  if (source.alignment === 'no_lookahead') {
    return alignNoLookahead(transformed, source.monthlyMethod || 'last', DEFAULT_GDP_LAG_MONTHS, now);
  }
  return toMonthly(transformed, source.monthlyMethod || 'last');
}

async function loadSourceWithMeta(source, options, missingInputs, sources) {
  try {
    const series = await loadSource(source, options);
    if (!series.length) throw new Error('No observations returned');
    sources.push(sourceMeta(source, 'ok'));
    return series;
  } catch (error) {
    sources.push(sourceMeta(source, 'missing', error));
    missingInputs.push(source.label || source.seriesId || source.path || source.kind);
    return null;
  }
}

function seriesMap(series) {
  return new Map(sortSeries(series).map((point) => [point.date, point.value]));
}

function buildContinuousIndex(seriesList, startDate, endDate) {
  const keys = seriesList.flatMap((series) => sortSeries(series).map((point) => point.date));
  if (!keys.length) return [];
  const start = keys.sort()[0] > startDate ? keys.sort()[0] : startDate;
  return monthRange(start, toMonthKey(endDate));
}

function valueOnDate(map, date, previous) {
  if (map.has(date)) return map.get(date);
  return previous;
}

async function buildCountrySeries(country, options, missingInputs, sources) {
  const [m2, gdp, fx] = await Promise.all([
    loadSourceWithMeta(country.m2, options, missingInputs, sources),
    loadSourceWithMeta(country.gdp, options, missingInputs, sources),
    loadSourceWithMeta(country.fx, options, missingInputs, sources),
  ]);

  if (!m2 || !gdp || !fx) return null;

  const index = buildContinuousIndex([m2, gdp, fx], options.startDate || DEFAULT_START_DATE, options.now || new Date());
  const m2Map = seriesMap(m2);
  const gdpMap = seriesMap(gdp);
  const fxMap = seriesMap(fx);
  let lastM2 = null;
  let lastGdp = null;
  let lastFx = null;

  return index.map((date) => {
    lastM2 = valueOnDate(m2Map, date, lastM2);
    lastGdp = valueOnDate(gdpMap, date, lastGdp);
    lastFx = valueOnDate(fxMap, date, lastFx);
    return {
      date,
      [`${country.code}_m2_usd`]: Number.isFinite(lastM2) && Number.isFinite(lastFx) ? lastM2 * lastFx : null,
      [`${country.code}_gdp_usd`]: Number.isFinite(lastGdp) && Number.isFinite(lastFx) ? lastGdp * lastFx : null,
    };
  });
}

function mergeRows(rowSets) {
  const dates = Array.from(new Set(rowSets.flatMap((rows) => rows.map((row) => row.date)))).sort();
  const bySet = rowSets.map((rows) => new Map(rows.map((row) => [row.date, row])));
  return dates.map((date) => Object.assign({ date }, ...bySet.map((map) => map.get(date) || {})));
}

async function buildGlobalModel(options = {}) {
  const sources = [];
  const missingInputs = [];
  const countryRows = await Promise.all(
    GLOBAL_COUNTRIES.map((country) => buildCountrySeries(country, options, missingInputs, sources))
  );

  if (missingInputs.length > 0) {
    return {
      status: sources.some((source) => source.status === 'ok') ? 'partial' : 'unavailable',
      latest: null,
      history: [],
      sources,
      missingInputs,
    };
  }

  let rows = mergeRows(countryRows.filter(Boolean)).map((row) => {
    const m2Columns = GLOBAL_COUNTRIES.map((country) => `${country.code}_m2_usd`);
    const gdpColumns = GLOBAL_COUNTRIES.map((country) => `${country.code}_gdp_usd`);
    const allM2 = m2Columns.map((column) => row[column]);
    const allGdp = gdpColumns.map((column) => row[column]);
    const globalM2Usd = allM2.every(Number.isFinite) ? allM2.reduce((sum, value) => sum + value, 0) : null;
    const globalNominalGdpUsd = allGdp.every(Number.isFinite) ? allGdp.reduce((sum, value) => sum + value, 0) : null;
    return {
      ...row,
      global_m2_usd: globalM2Usd,
      global_nominal_gdp_usd: globalNominalGdpUsd,
      m2_to_gdp: Number.isFinite(globalM2Usd) && Number.isFinite(globalNominalGdpUsd) ? globalM2Usd / globalNominalGdpUsd : null,
    };
  });

  rows = withGrowthRows(rows, 'global_m2_usd', 'm2_growth');
  rows = withGrowthRows(rows, 'global_nominal_gdp_usd', 'gdp_growth');
  rows = withGrowthRows(rows, 'm2_to_gdp', 'm2_to_gdp_change').map((row) => {
    const next = { ...row };
    [1, 3, 6, 12].forEach((months) => {
      const m2 = next[`m2_growth_${months}m_ann`];
      const gdp = next[`gdp_growth_${months}m_ann`];
      next[`growth_gap_${months}m_ann`] = Number.isFinite(m2) && Number.isFinite(gdp) ? m2 - gdp : null;
    });
    const riskGrowthGap = averageFinite([next.growth_gap_3m_ann, next.growth_gap_6m_ann]);
    const riskScore = weightedScore({
      m2Growth1m: { value: growthRisk(next.m2_growth_1m_ann), weight: GLOBAL_LIQUIDITY_WEIGHTS.m2_growth_1m },
      m2Growth3m: { value: growthRisk(next.m2_growth_3m_ann), weight: GLOBAL_LIQUIDITY_WEIGHTS.m2_growth_3m },
      m2Growth6m: { value: growthRisk(next.m2_growth_6m_ann), weight: GLOBAL_LIQUIDITY_WEIGHTS.m2_growth_6m },
      gap: { value: gapRisk(riskGrowthGap), weight: GLOBAL_LIQUIDITY_WEIGHTS.growth_gap },
      ratio: {
        value: weightedScore({
          level: { value: ratioLevelRisk(next.m2_to_gdp), weight: GLOBAL_LIQUIDITY_RATIO_PRESSURE_WEIGHTS.level },
          trend3m: { value: ratioTrendRisk(next.m2_to_gdp_change_3m_ann), weight: GLOBAL_LIQUIDITY_RATIO_PRESSURE_WEIGHTS.trend3m },
          trend6m: { value: ratioTrendRisk(next.m2_to_gdp_change_6m_ann), weight: GLOBAL_LIQUIDITY_RATIO_PRESSURE_WEIGHTS.trend6m },
        }),
        weight: GLOBAL_LIQUIDITY_WEIGHTS.m2_to_gdp_pressure,
      },
    });
    next.liquidity_risk_score = riskScore;
    next.regime = regimeLabel(riskScore);
    return next;
  });

  const latest = latestComplete(rows, ['liquidity_risk_score']);
  return {
    status: latest ? 'ok' : 'unavailable',
    latest: latest ? formatGlobalLatest(latest) : null,
    history: rows.filter((row) => Number.isFinite(row.liquidity_risk_score)).slice(-HISTORY_LIMIT).map(formatGlobalHistory),
    sources,
    missingInputs,
  };
}

function averageFinite(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}

function formatGrowth(row, prefix) {
  return {
    '1m': numberOrNull(row[`${prefix}_1m_ann`]),
    '3m': numberOrNull(row[`${prefix}_3m_ann`]),
    '6m': numberOrNull(row[`${prefix}_6m_ann`]),
    '12m': numberOrNull(row[`${prefix}_12m_ann`]),
  };
}

function formatGlobalLatest(row) {
  return {
    date: row.date,
    globalM2Usd: numberOrNull(row.global_m2_usd),
    globalNominalGdpUsd: numberOrNull(row.global_nominal_gdp_usd),
    m2ToGdp: numberOrNull(row.m2_to_gdp),
    growth: formatGrowth(row, 'm2_growth'),
    growthGap: formatGrowth(row, 'growth_gap'),
    riskScore: numberOrNull(row.liquidity_risk_score),
    regime: row.regime,
  };
}

function formatGlobalHistory(row) {
  return {
    date: row.date,
    globalM2Usd: numberOrNull(row.global_m2_usd),
    globalNominalGdpUsd: numberOrNull(row.global_nominal_gdp_usd),
    m2ToGdp: numberOrNull(row.m2_to_gdp),
    riskScore: numberOrNull(row.liquidity_risk_score),
    regime: row.regime,
  };
}

async function buildUsModel(options = {}) {
  const sources = [];
  const missingInputs = [];
  const componentSeries = {};
  const componentColumns = [];
  const provisionalComponents = [];

  for (const component of US_STACK_CONFIG.components) {
    if (component.source) {
      const source = { ...component.source, provisional: component.provisional };
      const series = await loadSourceWithMeta(source, options, missingInputs, sources);
      if (series) componentSeries[component.code] = series;
    } else if (component.derived) {
      const left = componentSeries[component.derived.left];
      const right = componentSeries[component.derived.right];
      if (!left || !right) {
        missingInputs.push(component.name);
        sources.push({ label: component.name, kind: 'derived', status: 'missing', provisional: Boolean(component.provisional), error: 'Missing derived inputs' });
      } else {
        try {
          componentSeries[component.code] = deriveSubtract(component, left, right, options.now);
        } catch (error) {
          missingInputs.push(component.name);
          sources.push({
            label: component.name,
            kind: 'derived',
            status: 'missing',
            provisional: Boolean(component.provisional),
            error: error.message,
          });
        }
      }
    }

    if (component.code !== 'total_mmf') componentColumns.push(component.code);
    if (component.provisional) provisionalComponents.push(component.name);
  }

  const gdp = await loadSourceWithMeta(US_STACK_CONFIG.gdp, options, missingInputs, sources);
  if (!gdp) {
    return { status: 'unavailable', latest: null, components: [], history: [], sources, missingInputs };
  }

  if (missingInputs.length > 0) {
    return {
      status: 'unavailable',
      latest: null,
      components: [],
      history: [],
      sources,
      missingInputs,
    };
  }

  const allSeries = [...Object.values(componentSeries), gdp];
  const index = buildContinuousIndex(allSeries, options.startDate || DEFAULT_START_DATE, options.now || new Date());
  const maps = Object.fromEntries(Object.entries(componentSeries).map(([code, series]) => [code, seriesMap(series)]));
  const gdpMap = seriesMap(gdp);
  const last = {};
  let lastGdp = null;

  let rows = index.map((date) => {
    const row = { date };
    componentColumns.forEach((code) => {
      last[code] = valueOnDate(maps[code], date, last[code]);
      row[`stack_${code}`] = last[code];
    });
    lastGdp = valueOnDate(gdpMap, date, lastGdp);
    row.stack_nominal_gdp_usd = lastGdp;
    const componentValues = componentColumns.map((code) => row[`stack_${code}`]);
    row.dollar_liquidity_stack = componentValues.every(Number.isFinite)
      ? componentValues.reduce((sum, value) => sum + value, 0)
      : null;
    row.stack_to_gdp = Number.isFinite(row.dollar_liquidity_stack) && Number.isFinite(row.stack_nominal_gdp_usd)
      ? row.dollar_liquidity_stack / row.stack_nominal_gdp_usd
      : null;
    return row;
  });

  rows = withGrowthRows(rows, 'dollar_liquidity_stack', 'stack_growth').map((row) => ({
    ...row,
    stack_accel_1m_vs_3m: accelerationLabel(row.stack_growth_1m_ann, row.stack_growth_3m_ann),
    stack_accel_3m_vs_6m: accelerationLabel(row.stack_growth_3m_ann, row.stack_growth_6m_ann),
    stack_accel_6m_vs_12m: accelerationLabel(row.stack_growth_6m_ann, row.stack_growth_12m_ann),
    stack_regime: stackRegime(row),
  }));

  const latest = latestComplete(rows, ['dollar_liquidity_stack', 'stack_to_gdp', 'stack_growth_12m_ann']);
  const components = latest ? componentColumns.map((code) => {
    const config = US_STACK_CONFIG.components.find((item) => item.code === code);
    const value = latest[`stack_${code}`];
    return {
      code,
      name: config ? config.name : code,
      value: numberOrNull(value),
      share: Number.isFinite(value) && latest.dollar_liquidity_stack > 0 ? value / latest.dollar_liquidity_stack : null,
      provisional: Boolean(config && config.provisional),
    };
  }) : [];

  return {
    status: latest ? 'ok' : 'unavailable',
    latest: latest ? formatUsLatest(latest) : null,
    components,
    history: rows.filter((row) => Number.isFinite(row.stack_growth_12m_ann)).slice(-HISTORY_LIMIT).map(formatUsHistory),
    sources,
    missingInputs,
    provisionalComponents,
  };
}

function deriveSubtract(component, left, right, now = new Date()) {
  const index = buildContinuousIndex([left, right], DEFAULT_START_DATE, now);
  const leftMap = seriesMap(left);
  const rightMap = seriesMap(right);
  let lastLeft = null;
  let lastRight = null;
  const derived = index.map((date) => {
    lastLeft = valueOnDate(leftMap, date, lastLeft);
    lastRight = valueOnDate(rightMap, date, lastRight);
    return {
      date,
      value: Number.isFinite(lastLeft) && Number.isFinite(lastRight) ? lastLeft - lastRight : null,
    };
  }).filter((point) => Number.isFinite(point.value));

  if (!component.derived.allowNegative && derived.some((point) => point.value < 0)) {
    throw new Error(`Derived component ${component.code} produced negative values`);
  }
  return derived;
}

function formatUsLatest(row) {
  return {
    date: row.date,
    dollarLiquidityStack: numberOrNull(row.dollar_liquidity_stack),
    stackNominalGdpUsd: numberOrNull(row.stack_nominal_gdp_usd),
    stackToGdp: numberOrNull(row.stack_to_gdp),
    growth: formatGrowth(row, 'stack_growth'),
    acceleration: {
      '1mVs3m': row.stack_accel_1m_vs_3m,
      '3mVs6m': row.stack_accel_3m_vs_6m,
      '6mVs12m': row.stack_accel_6m_vs_12m,
    },
    regime: row.stack_regime,
  };
}

function formatUsHistory(row) {
  return {
    date: row.date,
    dollarLiquidityStack: numberOrNull(row.dollar_liquidity_stack),
    stackNominalGdpUsd: numberOrNull(row.stack_nominal_gdp_usd),
    stackToGdp: numberOrNull(row.stack_to_gdp),
    regime: row.stack_regime,
  };
}

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

async function loadDailySeries(source, options, missingInputs, sources) {
  try {
    const raw = options.loadSeriesOverride
      ? await options.loadSeriesOverride(source)
      : await fetchFredCsv(source.seriesId, options.axiosClient);
    const scale = source.scale == null ? 1 : Number(source.scale);
    const series = (raw || [])
      .map((point) => ({ date: String(point.date).slice(0, 10), value: Number(point.value) * scale }))
      .filter((point) => /^\d{4}-\d{2}-\d{2}$/.test(point.date) && Number.isFinite(point.value))
      .sort((a, b) => a.date.localeCompare(b.date));
    if (!series.length) throw new Error('No observations returned');
    sources.push(sourceMeta(source, 'ok'));
    return series;
  } catch (error) {
    sources.push(sourceMeta(source, 'missing', error));
    missingInputs.push(source.label || source.seriesId);
    return null;
  }
}

// Latest observation on or before date, within maxGapDays; no lookahead.
function asOfValue(series, date, maxGapDays = 7) {
  let low = 0;
  let high = series.length - 1;
  let found = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (series[mid].date <= date) {
      found = series[mid];
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (!found) return null;
  const gapDays = (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${found.date}T00:00:00Z`)) / DAY_MS;
  return gapDays <= maxGapDays ? found.value : null;
}

function directionLabel(change, level, tolerance = NET_LIQUIDITY_DIRECTION_TOLERANCE) {
  if (!Number.isFinite(change) || !Number.isFinite(level) || level <= 0) return 'unavailable';
  const share = change / level;
  if (share > tolerance) return 'expanding';
  if (share < -tolerance) return 'contracting';
  return 'flat';
}

function netLiquidityRegime(changes) {
  const short = changes['4w']?.direction;
  const medium = changes['13w']?.direction;
  if (!short || !medium || short === 'unavailable' || medium === 'unavailable') return 'unavailable';
  if (short === 'expanding' && medium === 'expanding') return 'expanding';
  if (short === 'contracting' && medium === 'contracting') return 'contracting';
  return 'mixed';
}

async function buildNetLiquidityModel(options = {}) {
  const now = options.now || new Date();
  const sources = [];
  const missingInputs = [];
  const [fed, tga, rrp] = await Promise.all([
    loadDailySeries(NET_LIQUIDITY_CONFIG.fedBalanceSheet, options, missingInputs, sources),
    loadDailySeries(NET_LIQUIDITY_CONFIG.treasuryGeneralAccount, options, missingInputs, sources),
    loadDailySeries(NET_LIQUIDITY_CONFIG.reverseRepo, options, missingInputs, sources),
  ]);
  const unavailable = {
    status: 'unavailable', latest: null, history: [], sources, missingInputs,
  };
  if (!fed || !tga || !rrp) return unavailable;

  // The Fed balance sheet's Wednesday dates are the weekly index.
  const rows = fed.map((point) => {
    const treasuryGeneralAccount = asOfValue(tga, point.date);
    const reverseRepo = asOfValue(rrp, point.date);
    const complete = Number.isFinite(treasuryGeneralAccount) && Number.isFinite(reverseRepo);
    return {
      date: point.date,
      fedBalanceSheet: point.value,
      treasuryGeneralAccount,
      reverseRepo,
      netLiquidity: complete ? point.value - treasuryGeneralAccount - reverseRepo : null,
    };
  }).filter((row) => Number.isFinite(row.netLiquidity));
  if (!rows.length) return unavailable;

  const latestIndex = rows.length - 1;
  const latest = rows[latestIndex];
  const changes = Object.fromEntries(Object.entries(NET_LIQUIDITY_WINDOWS_WEEKS).map(([key, weeks]) => {
    const prior = rows[latestIndex - weeks];
    // Only compare against the row that is exactly that many weeks back.
    const expected = new Date(Date.parse(`${latest.date}T00:00:00Z`) - weeks * 7 * DAY_MS).toISOString().slice(0, 10);
    if (!prior || prior.date !== expected) return [key, { change: null, pct: null, direction: 'unavailable' }];
    const change = latest.netLiquidity - prior.netLiquidity;
    return [key, {
      change,
      pct: prior.netLiquidity > 0 ? change / prior.netLiquidity : null,
      direction: directionLabel(change, prior.netLiquidity),
    }];
  }));
  const ageDays = (new Date(now).getTime() - Date.parse(`${latest.date}T00:00:00Z`)) / DAY_MS;
  const stale = ageDays > NET_LIQUIDITY_MAX_AGE_DAYS;

  return {
    status: stale ? 'stale' : 'ok',
    latest: { ...latest, changes, regime: netLiquidityRegime(changes) },
    history: rows.slice(-NET_LIQUIDITY_HISTORY_WEEKS),
    sources,
    missingInputs,
  };
}

async function buildLiquidityModels(options = {}) {
  const now = options.now || new Date();
  const baseOptions = {
    startDate: options.startDate || DEFAULT_START_DATE,
    baseDir: options.baseDir || process.cwd(),
    axiosClient: options.axiosClient,
    loadSeriesOverride: options.loadSeriesOverride,
    now,
  };

  const [global, us, netLiquidity] = await Promise.all([
    buildGlobalModel(baseOptions),
    buildUsModel(baseOptions),
    buildNetLiquidityModel(baseOptions),
  ]);

  return {
    timestamp: now.toISOString(),
    models: { global, us, netLiquidity },
  };
}

module.exports = {
  annualizedRate,
  accelerationLabel,
  alignNoLookahead,
  buildLiquidityModels,
  buildGlobalModel,
  buildNetLiquidityModel,
  buildUsModel,
  deriveSubtract,
  parseCsvSeries,
  regimeLabel,
  stackRegime,
  toMonthly,
};
