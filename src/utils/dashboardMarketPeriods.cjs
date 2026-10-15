const PERIOD_RETURN_FIELDS = [
  'weekChangePct', 'fifteenDayChangePct', 'thirtyDayChangePct', 'ninetyDayChangePct',
  'monthChangePct', 'threeMonthChangePct', 'sixMonthChangePct', 'mtdChangePct',
  'qtdChangePct', 'ytdChangePct', 'oneYearChangePct',
];

const PERIOD_RETURN_BPS_FIELDS = [
  'weekChangeBps', 'fifteenDayChangeBps', 'monthChangeBps', 'threeMonthChangeBps',
  'sixMonthChangeBps', 'ytdChangeBps', 'oneYearChangeBps',
];

const PERIOD_RETURN_REFERENCE_FIELDS = ['latestObservationChange', 'backdropPercentageReturns'];

const PERIOD_RETURN_METADATA_FIELDS = [
  'periodReturnsAsOf', 'periodReturnsStatus', 'periodReturnsSource',
  'periodObservationFrequency', 'periodSourceSeriesId', 'periodSourceInstrument',
  'periodSourceUrl', 'periodReturnProvenance',
];

const QUOTE_VISUAL_FIELDS = ['sparklineData'];
const MONTHLY_UNSUPPORTED_FIELDS = new Set([
  'weekChangePct', 'fifteenDayChangePct', 'weekChangeBps', 'fifteenDayChangeBps',
]);
const REJECTED_PERIOD_EVIDENCE = /mock|seed|synthetic|inferred|portfolio|cost-basis|cache|stale|offline|disconnected/i;

const hasUsablePeriodMetadata = (row) => (
  !REJECTED_PERIOD_EVIDENCE.test(String(row?.periodReturnsSource || ''))
    && (row?.periodReturnsStatus == null || row.periodReturnsStatus === 'historical')
    && (row?.periodReturnsAsOf == null
      || Number.isFinite(Date.parse(String(row.periodReturnsAsOf))))
);

const periodProvenance = (row, field) => (
  row.periodReturnProvenance?.[field] || {
    asOf: row.periodReturnsAsOf || null,
    source: row.periodReturnsSource || null,
    sourceSeriesId: row.periodSourceSeriesId || null,
    sourceInstrument: row.periodSourceInstrument || null,
    sourceUrl: row.periodSourceUrl || null,
    observationFrequency: row.periodObservationFrequency || row.latestObservationChange?.interval || null,
  }
);

const mergeMarketRowPreservingPeriods = (
  previous,
  row,
  { preservePeriods = true } = {},
) => {
  if (!previous || !row) return row;
  const merged = { ...row };
  const previousFrequency = previous.periodObservationFrequency || previous.latestObservationChange?.interval;
  // A provider name is not an instrument identity. A current native index quote
  // can use another provider's history for that same symbol. Explicit benchmark
  // identifiers/frequencies still prevent borrowing a different sovereign series.
  const benchmarkObservation = Boolean(row.sourceSeriesId || row.observationFrequency);
  const compatibleSeries = !(benchmarkObservation
    && previous.periodSourceSeriesId && previous.periodReturnsSource && row.source
    && row.source !== previous.periodReturnsSource)
    && !(row.sourceSeriesId && previous.periodSourceSeriesId
      && row.sourceSeriesId !== previous.periodSourceSeriesId)
    && !(row.periodSourceSeriesId && previous.periodSourceSeriesId
      && row.periodSourceSeriesId !== previous.periodSourceSeriesId)
    && !(row.observationFrequency === 'daily' && previousFrequency === 'monthly')
    && !(row.periodObservationFrequency && previousFrequency
      && row.periodObservationFrequency !== previousFrequency);
  const hasIncomingPeriods = row.periodReturnsStatus === 'historical'
    && Number.isFinite(Date.parse(String(row.periodReturnsAsOf || '')));
  const inheritPeriods = preservePeriods && compatibleSeries && hasUsablePeriodMetadata(previous);
  const retainedProvenance = { ...(row.periodReturnProvenance || {}) };
  [...PERIOD_RETURN_FIELDS, ...PERIOD_RETURN_BPS_FIELDS, ...PERIOD_RETURN_REFERENCE_FIELDS].forEach((field) => {
    const unsupported = hasIncomingPeriods && row.periodObservationFrequency === 'monthly'
      && MONTHLY_UNSUPPORTED_FIELDS.has(field);
    if (inheritPeriods && !unsupported && row[field] == null && previous[field] != null) {
      merged[field] = previous[field];
      retainedProvenance[field] = { ...periodProvenance(previous, field), retained: true };
    }
  });
  PERIOD_RETURN_METADATA_FIELDS.forEach((field) => {
    if (field !== 'periodReturnProvenance' && inheritPeriods && !hasIncomingPeriods && previous[field] != null) {
      merged[field] = previous[field];
    }
  });
  if (Object.keys(retainedProvenance).length > 0) merged.periodReturnProvenance = retainedProvenance;
  QUOTE_VISUAL_FIELDS.forEach((field) => {
    if ((!Array.isArray(row[field]) || row[field].length === 0) && Array.isArray(previous[field]) && previous[field].length > 0) {
      merged[field] = previous[field];
    }
  });
  return merged;
};

const mergeRowsPreservingPeriods = (previousRows = [], nextRows = [], options = {}) => {
  if (!Array.isArray(previousRows) || !Array.isArray(nextRows)) return nextRows;
  const previousBySymbol = new Map(previousRows.map((row) => [row?.symbol, row]));
  return nextRows.map((row) => mergeMarketRowPreservingPeriods(previousBySymbol.get(row?.symbol), row, options));
};

const mergeMarketDataPreservingPeriods = (previous = {}, next = {}, options = {}) => {
  const merged = { ...previous, ...next };
  Object.entries(next || {}).forEach(([regionKey, regionValue]) => {
    if (Array.isArray(regionValue)) {
      merged[regionKey] = mergeRowsPreservingPeriods(previous?.[regionKey], regionValue, options);
      return;
    }
    if (regionValue && typeof regionValue === 'object') {
      merged[regionKey] = Object.fromEntries(
        Object.entries(regionValue).map(([tabKey, rows]) => [
          tabKey,
          mergeRowsPreservingPeriods(previous?.[regionKey]?.[tabKey], rows, options),
        ])
      );
    }
  });
  return merged;
};

module.exports = {
  PERIOD_RETURN_FIELDS,
  PERIOD_RETURN_BPS_FIELDS,
  PERIOD_RETURN_REFERENCE_FIELDS,
  PERIOD_RETURN_METADATA_FIELDS,
  mergeMarketRowPreservingPeriods,
  mergeMarketDataPreservingPeriods,
};
