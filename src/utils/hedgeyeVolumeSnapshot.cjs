const SOURCE_BREAKDOWN = [
  {
    id: 'hedgeyeVolumeSnapshot',
    label: 'Hedgeye Volume Snapshot',
    description: 'Direct AWS Textract extraction from the uploaded Hedgeye volume slide PDF.',
    provider: 'Hedgeye',
    dataset: 'The Macro Show'
  }
];

const EMPTY_METRICS = {
  priorDay: null,
  avg1M: null,
  avg3M: null,
  avg1Y: null,
  pctPriorDay: null,
  pct1M: null,
  pct3M: null,
  pct1Y: null
};

function normalizeMetricBlock(block = {}) {
  return {
    ...EMPTY_METRICS,
    ...block
  };
}

function normalizeVolumeSnapshotData(snapshotItem = {}) {
  const data = snapshotItem.data || {};
  const metrics = data.metrics || {};

  return {
    slideDate: data.slideDate || snapshotItem.slideDate || snapshotItem.date || null,
    uploadDate: data.uploadDate || snapshotItem.uploadDate || snapshotItem.date || null,
    asOfLabel: data.asOfLabel || snapshotItem.asOfLabel || null,
    asOfTradingDate: data.asOfTradingDate || snapshotItem.asOfTradingDate || null,
    metrics: {
      totalMarket: normalizeMetricBlock(metrics.totalMarket),
      exchange: normalizeMetricBlock(metrics.exchange)
    },
    footnotes: Array.isArray(data.footnotes) ? data.footnotes : []
  };
}

function buildHedgeyeVolumeSnapshotResponse(snapshotItem) {
  if (!snapshotItem) return null;

  const normalized = normalizeVolumeSnapshotData(snapshotItem);

  return {
    asOf: normalized.asOfTradingDate,
    totalMarket: [],
    totalExchange: [],
    metrics: normalized.metrics,
    meta: {
      sourceType: 'hedgeye-volume-snapshot',
      methodologyVersion:
        snapshotItem.methodologyVersion ||
        snapshotItem.data?.methodologyVersion ||
        'hedgeye-volume-snapshot-v1',
      sourceBreakdown: SOURCE_BREAKDOWN,
      asOfTradingDate: normalized.asOfTradingDate,
      uploadDate: normalized.uploadDate,
      slideDate: normalized.slideDate,
      fetchedAt: snapshotItem.scrapedAt || snapshotItem.fetchedAt || null,
      status: snapshotItem.status || 'current',
      footnotes: normalized.footnotes
    }
  };
}

module.exports = {
  buildHedgeyeVolumeSnapshotResponse,
  normalizeVolumeSnapshotData
};
