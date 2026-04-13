const DEFAULT_COMPARISON_WINDOWS = Object.freeze({
  priorDay: 1,
  avg1M: 21,
  avg3M: 63,
  avg1Y: 252
});

const MARKET_STRUCTURE_SERIES_ID = 'US_EQUITY_MARKET_STRUCTURE';
const DEFAULT_MARKET_STRUCTURE_TABLE = 'MarketStructureDaily';
const DEFAULT_METHODOLOGY_VERSION = 'market-structure-cboe-consolidated-v1';
const DEFAULT_CACHE_PATH = 'data/market-structure/market_structure_daily.json';
const DEFAULT_CALIBRATION_REPORT_PATH = 'data/market-structure/market_structure_calibration_report.json';
const DEFAULT_BENCHMARK_PATH = 'data/hedgeye/market_share_volume_benchmarks.csv';
const DEFAULT_CBOE_URL_TEMPLATE =
  'https://www.cboe.com/us/equities/market_statistics/historical_market_volume/market_history_{year}.csv-dl';

const DEFAULT_SOURCE_BREAKDOWN = Object.freeze([
  {
    id: 'totalMarketVolume',
    label: 'Total Market Volume',
    description:
      'Consolidated listed + off-exchange share volume from Cboe historical market volume participants.',
    provider: 'Cboe',
    dataset: 'Historical Market Volume'
  },
  {
    id: 'totalExchangeVolume',
    label: 'Total Exchange Volume',
    description:
      'Listed U.S. exchange share volume from Cboe historical market volume, excluding TRF participants.',
    provider: 'Cboe',
    dataset: 'Historical Market Volume'
  }
]);

const METHODOLOGY_CANDIDATES = Object.freeze([
  {
    id: DEFAULT_METHODOLOGY_VERSION,
    label: 'Cboe consolidated shares',
    totalKey: 'totalMarketVolume',
    exchangeKey: 'totalExchangeVolume'
  },
  {
    id: 'market-structure-cboe-consolidated-notional-v1',
    label: 'Cboe consolidated notional',
    totalKey: 'totalMarketNotional',
    exchangeKey: 'totalExchangeNotional'
  },
  {
    id: 'market-structure-cboe-total-notional-exchange-volume-v1',
    label: 'Cboe total notional + exchange volume',
    totalKey: 'totalMarketNotional',
    exchangeKey: 'totalExchangeVolume'
  },
  {
    id: 'market-structure-cboe-total-volume-exchange-notional-v1',
    label: 'Cboe total volume + exchange notional',
    totalKey: 'totalMarketVolume',
    exchangeKey: 'totalExchangeNotional'
  }
]);

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function average(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return total / values.length;
}

function calculatePercentDifference(currentValue, baselineValue) {
  if (currentValue == null || baselineValue == null || baselineValue === 0) {
    return null;
  }

  return ((currentValue - baselineValue) / baselineValue) * 100;
}

function compareDateStringsDescending(left, right) {
  return String(right).localeCompare(String(left));
}

function sortRecordsDescending(records) {
  return [...records].sort((left, right) => compareDateStringsDescending(left.date, right.date));
}

function normalizeMarketStructureRecord(record, defaults = {}) {
  if (!record || !record.date) return null;

  const totalMarketVolume = toNumber(record.totalMarketVolume);
  const totalOffExchangeVolume = toNumber(record.totalOffExchangeVolume);
  const totalExchangeVolume =
    toNumber(record.totalExchangeVolume) ??
    (totalMarketVolume != null && totalOffExchangeVolume != null
      ? totalMarketVolume - totalOffExchangeVolume
      : null);

  const totalMarketNotional = toNumber(record.totalMarketNotional);
  const totalOffExchangeNotional = toNumber(record.totalOffExchangeNotional);
  const totalExchangeNotional =
    toNumber(record.totalExchangeNotional) ??
    (totalMarketNotional != null && totalOffExchangeNotional != null
      ? totalMarketNotional - totalOffExchangeNotional
      : null);

  return {
    seriesId: record.seriesId || defaults.seriesId || MARKET_STRUCTURE_SERIES_ID,
    date: String(record.date),
    totalExchangeVolume,
    totalOffExchangeVolume,
    totalMarketVolume,
    totalExchangeNotional,
    totalOffExchangeNotional,
    totalMarketNotional,
    sourceBreakdown: record.sourceBreakdown || defaults.sourceBreakdown || DEFAULT_SOURCE_BREAKDOWN,
    methodologyVersion:
      record.methodologyVersion || defaults.methodologyVersion || DEFAULT_METHODOLOGY_VERSION,
    fetchedAt: record.fetchedAt || defaults.fetchedAt || null,
    status: record.status || defaults.status || 'ready'
  };
}

function parseCsvText(text) {
  if (!text) return [];

  const rows = [];
  let currentField = '';
  let currentRow = [];
  let insideQuotes = false;

  const pushField = () => {
    currentRow.push(currentField);
    currentField = '';
  };

  const pushRow = () => {
    if (currentRow.length > 0) {
      rows.push(currentRow);
    }
    currentRow = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const nextCharacter = text[index + 1];

    if (character === '"') {
      if (insideQuotes && nextCharacter === '"') {
        currentField += '"';
        index += 1;
      } else {
        insideQuotes = !insideQuotes;
      }
      continue;
    }

    if (!insideQuotes && character === ',') {
      pushField();
      continue;
    }

    if (!insideQuotes && (character === '\n' || character === '\r')) {
      if (character === '\r' && nextCharacter === '\n') {
        index += 1;
      }
      pushField();
      pushRow();
      continue;
    }

    currentField += character;
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    pushField();
    pushRow();
  }

  if (rows.length === 0) return [];

  const [headerRow, ...dataRows] = rows;
  return dataRows
    .filter((row) => row.some((field) => String(field || '').trim() !== ''))
    .map((row) => {
      const record = {};
      headerRow.forEach((header, columnIndex) => {
        record[header] = row[columnIndex] ?? '';
      });
      return record;
    });
}

function isTrfParticipant(marketParticipant) {
  return /TRF/i.test(String(marketParticipant || ''));
}

function aggregateCboeHistoricalRows(rows, options = {}) {
  const fetchedAt = options.fetchedAt || new Date().toISOString();
  const methodologyVersion = options.methodologyVersion || DEFAULT_METHODOLOGY_VERSION;
  const byDate = new Map();

  rows.forEach((row) => {
    const date = String(row.Day || row.date || '').trim();
    const marketParticipant = String(row['Market Participant'] || row.marketParticipant || '').trim();
    const totalShares = toNumber(row['Total Shares'] || row.totalShares);
    const totalNotional = toNumber(row['Total Notional'] || row.totalNotional);

    if (!date || totalShares == null) {
      return;
    }

    const existing =
      byDate.get(date) ||
      {
        seriesId: MARKET_STRUCTURE_SERIES_ID,
        date,
        totalExchangeVolume: 0,
        totalOffExchangeVolume: 0,
        totalMarketVolume: 0,
        totalExchangeNotional: 0,
        totalOffExchangeNotional: 0,
        totalMarketNotional: 0,
        sourceBreakdown: DEFAULT_SOURCE_BREAKDOWN,
        methodologyVersion,
        fetchedAt,
        status: 'ready'
      };

    existing.totalMarketVolume += totalShares;
    if (totalNotional != null) {
      existing.totalMarketNotional += totalNotional;
    }

    if (isTrfParticipant(marketParticipant)) {
      existing.totalOffExchangeVolume += totalShares;
      if (totalNotional != null) {
        existing.totalOffExchangeNotional += totalNotional;
      }
    } else {
      existing.totalExchangeVolume += totalShares;
      if (totalNotional != null) {
        existing.totalExchangeNotional += totalNotional;
      }
    }

    byDate.set(date, existing);
  });

  return sortRecordsDescending(
    Array.from(byDate.values()).map((record) => normalizeMarketStructureRecord(record))
  );
}

function calculateSeriesComparisons(series, windows = DEFAULT_COMPARISON_WINDOWS, asOfDate = null) {
  if (!Array.isArray(series) || series.length < 2) {
    return {
      date: asOfDate || null,
      current: null,
      priorDay: null,
      avg1M: null,
      avg3M: null,
      avg1Y: null,
      pctPriorDay: null,
      pct1M: null,
      pct3M: null,
      pct1Y: null
    };
  }

  const sortedSeries = sortRecordsDescending(series);
  const startIndex = asOfDate
    ? sortedSeries.findIndex((record) => record.date === asOfDate)
    : 0;

  if (startIndex === -1) {
    return {
      date: asOfDate || null,
      current: null,
      priorDay: null,
      avg1M: null,
      avg3M: null,
      avg1Y: null,
      pctPriorDay: null,
      pct1M: null,
      pct3M: null,
      pct1Y: null
    };
  }

  const currentRecord = sortedSeries[startIndex];
  const trailingRecords = sortedSeries.slice(startIndex + 1);
  const currentValue = currentRecord.value;
  const priorDayValue = trailingRecords[0]?.value ?? null;
  const avg1M = average(trailingRecords.slice(0, windows.avg1M).map((record) => record.value));
  const avg3M = average(trailingRecords.slice(0, windows.avg3M).map((record) => record.value));
  const avg1Y = average(trailingRecords.slice(0, windows.avg1Y).map((record) => record.value));

  return {
    date: currentRecord.date,
    current: currentValue,
    priorDay: priorDayValue,
    avg1M,
    avg3M,
    avg1Y,
    pctPriorDay: calculatePercentDifference(currentValue, priorDayValue),
    pct1M: calculatePercentDifference(currentValue, avg1M),
    pct3M: calculatePercentDifference(currentValue, avg3M),
    pct1Y: calculatePercentDifference(currentValue, avg1Y)
  };
}

function buildSeriesFromRecords(records, valueKey, limit) {
  return sortRecordsDescending(records)
    .filter((record) => record[valueKey] != null)
    .slice(0, limit)
    .map((record) => ({
      date: record.date,
      value: record[valueKey]
    }));
}

function buildMetricArray(records, valueKey, limit) {
  return buildSeriesFromRecords(records, valueKey, limit).map((record) => ({
    date: record.date,
    volume: record.value
  }));
}

function summarizeCalibration(calibrationReport) {
  if (!calibrationReport?.selected?.summary) return null;

  return {
    selectedMethodologyId: calibrationReport.selected.id,
    selectedMethodologyLabel: calibrationReport.selected.label,
    benchmarkCount: calibrationReport.selected.summary.benchmarkCount,
    evaluatedCount: calibrationReport.selected.summary.evaluatedCount,
    exactMatchCount: calibrationReport.selected.summary.exactMatchCount,
    exactMatchRate: calibrationReport.selected.summary.exactMatchRate,
    maxAbsoluteError: calibrationReport.selected.summary.maxAbsoluteError,
    meanAbsoluteError: calibrationReport.selected.summary.meanAbsoluteError
  };
}

function buildMarketShareVolumeResponse(records, options = {}) {
  const normalizedRecords = sortRecordsDescending(
    (records || [])
      .map((record) =>
        normalizeMarketStructureRecord(record, {
          methodologyVersion: options.methodologyVersion,
          sourceBreakdown: options.sourceBreakdown,
          status: options.status
        })
      )
      .filter(Boolean)
  );

  const maxDays = options.days || normalizedRecords.length;
  const slicedRecords = normalizedRecords.slice(0, maxDays);
  const latestRecord = slicedRecords[0] || null;
  const sourceBreakdown =
    options.sourceBreakdown ||
    latestRecord?.sourceBreakdown ||
    DEFAULT_SOURCE_BREAKDOWN;

  return {
    asOf: latestRecord?.date || null,
    totalMarket: buildMetricArray(slicedRecords, 'totalMarketVolume', maxDays),
    totalExchange: buildMetricArray(slicedRecords, 'totalExchangeVolume', maxDays),
    meta: {
      methodologyVersion:
        options.methodologyVersion ||
        latestRecord?.methodologyVersion ||
        DEFAULT_METHODOLOGY_VERSION,
      sourceBreakdown,
      comparisonWindows: options.windows || DEFAULT_COMPARISON_WINDOWS,
      windows: options.windows || DEFAULT_COMPARISON_WINDOWS,
      asOfTradingDate: latestRecord?.date || null,
      fetchedAt: options.fetchedAt || latestRecord?.fetchedAt || null,
      status: options.status || latestRecord?.status || 'missing',
      calibration: summarizeCalibration(options.calibrationReport) || null
    }
  };
}

function parseBenchmarkCsvText(text) {
  return parseCsvText(text).map((row) => ({
    date: String(row.date || row.Day || '').trim(),
    totalMarket_priorDay: toNumber(row.totalMarket_priorDay),
    totalMarket_1M: toNumber(row.totalMarket_1M),
    totalMarket_3M: toNumber(row.totalMarket_3M),
    totalMarket_1Y: toNumber(row.totalMarket_1Y),
    totalExchange_priorDay: toNumber(row.totalExchange_priorDay),
    totalExchange_1M: toNumber(row.totalExchange_1M),
    totalExchange_3M: toNumber(row.totalExchange_3M),
    totalExchange_1Y: toNumber(row.totalExchange_1Y)
  }));
}

function roundPercent(value) {
  if (value == null || Number.isNaN(value)) return null;
  return Math.round(value);
}

function buildExpectedBenchmarkShape(row) {
  return {
    totalMarket_priorDay: row.totalMarket_priorDay,
    totalMarket_1M: row.totalMarket_1M,
    totalMarket_3M: row.totalMarket_3M,
    totalMarket_1Y: row.totalMarket_1Y,
    totalExchange_priorDay: row.totalExchange_priorDay,
    totalExchange_1M: row.totalExchange_1M,
    totalExchange_3M: row.totalExchange_3M,
    totalExchange_1Y: row.totalExchange_1Y
  };
}

function buildActualBenchmarkShape(totalMetrics, exchangeMetrics) {
  return {
    totalMarket_priorDay: roundPercent(totalMetrics.pctPriorDay),
    totalMarket_1M: roundPercent(totalMetrics.pct1M),
    totalMarket_3M: roundPercent(totalMetrics.pct3M),
    totalMarket_1Y: roundPercent(totalMetrics.pct1Y),
    totalExchange_priorDay: roundPercent(exchangeMetrics.pctPriorDay),
    totalExchange_1M: roundPercent(exchangeMetrics.pct1M),
    totalExchange_3M: roundPercent(exchangeMetrics.pct3M),
    totalExchange_1Y: roundPercent(exchangeMetrics.pct1Y)
  };
}

function buildCandidateSummaries(records, benchmarkRows, windows = DEFAULT_COMPARISON_WINDOWS) {
  return METHODOLOGY_CANDIDATES.map((candidate) => {
    const totalSeries = buildSeriesFromRecords(records, candidate.totalKey, records.length);
    const exchangeSeries = buildSeriesFromRecords(records, candidate.exchangeKey, records.length);

    const benchmarkResults = benchmarkRows.map((benchmarkRow) => {
      const totalMetrics = calculateSeriesComparisons(totalSeries, windows, benchmarkRow.date);
      const exchangeMetrics = calculateSeriesComparisons(exchangeSeries, windows, benchmarkRow.date);
      const actual = buildActualBenchmarkShape(totalMetrics, exchangeMetrics);
      const expected = buildExpectedBenchmarkShape(benchmarkRow);

      const fields = Object.keys(expected);
      const comparableFields = fields.filter(
        (fieldName) => expected[fieldName] != null && actual[fieldName] != null
      );
      const absoluteErrors = comparableFields.map((fieldName) =>
        Math.abs(actual[fieldName] - expected[fieldName])
      );
      const exactMatch = comparableFields.length === fields.length &&
        absoluteErrors.every((errorValue) => errorValue === 0);

      return {
        date: benchmarkRow.date,
        expected,
        actual,
        exactMatch,
        comparableFieldCount: comparableFields.length,
        absoluteErrors
      };
    });

    const evaluatedBenchmarks = benchmarkResults.filter(
      (result) => result.comparableFieldCount === 8
    );
    const allErrors = evaluatedBenchmarks.flatMap((result) => result.absoluteErrors);
    const exactMatchCount = evaluatedBenchmarks.filter((result) => result.exactMatch).length;

    return {
      id: candidate.id,
      label: candidate.label,
      totalKey: candidate.totalKey,
      exchangeKey: candidate.exchangeKey,
      summary: {
        benchmarkCount: benchmarkRows.length,
        evaluatedCount: evaluatedBenchmarks.length,
        exactMatchCount,
        exactMatchRate:
          benchmarkRows.length > 0 ? exactMatchCount / benchmarkRows.length : 0,
        maxAbsoluteError: allErrors.length > 0 ? Math.max(...allErrors) : null,
        meanAbsoluteError:
          allErrors.length > 0
            ? allErrors.reduce((sum, value) => sum + value, 0) / allErrors.length
            : null
      },
      benchmarks: benchmarkResults
    };
  }).sort((left, right) => {
    const leftError = left.summary.meanAbsoluteError ?? Number.POSITIVE_INFINITY;
    const rightError = right.summary.meanAbsoluteError ?? Number.POSITIVE_INFINITY;
    return leftError - rightError;
  });
}

function buildCalibrationReport(records, benchmarkRows, options = {}) {
  const candidateSummaries = buildCandidateSummaries(
    records,
    benchmarkRows,
    options.windows || DEFAULT_COMPARISON_WINDOWS
  );

  const selectedCandidateId = options.selectedMethodologyId || DEFAULT_METHODOLOGY_VERSION;
  const selected =
    candidateSummaries.find((candidate) => candidate.id === selectedCandidateId) ||
    candidateSummaries[0] ||
    null;

  return {
    generatedAt: options.generatedAt || new Date().toISOString(),
    selected,
    candidates: candidateSummaries
  };
}

module.exports = {
  DEFAULT_BENCHMARK_PATH,
  DEFAULT_CACHE_PATH,
  DEFAULT_CALIBRATION_REPORT_PATH,
  DEFAULT_CBOE_URL_TEMPLATE,
  DEFAULT_COMPARISON_WINDOWS,
  DEFAULT_MARKET_STRUCTURE_TABLE,
  DEFAULT_METHODOLOGY_VERSION,
  DEFAULT_SOURCE_BREAKDOWN,
  MARKET_STRUCTURE_SERIES_ID,
  METHODOLOGY_CANDIDATES,
  aggregateCboeHistoricalRows,
  buildCalibrationReport,
  buildMarketShareVolumeResponse,
  calculatePercentDifference,
  calculateSeriesComparisons,
  normalizeMarketStructureRecord,
  parseBenchmarkCsvText,
  parseCsvText,
  sortRecordsDescending
};
