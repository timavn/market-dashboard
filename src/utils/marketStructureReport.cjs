const MARKET_STRUCTURE_ASSET_PREFIX = 'hedgeye-email/assets/market-structure/';
const MARKET_STRUCTURE_CHART_ID_PATTERN = /^[a-f0-9]{64}$/;
const MARKET_STRUCTURE_ASSET_KEY_PATTERN = new RegExp(
  `^${MARKET_STRUCTURE_ASSET_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([a-f0-9]{64})\\.(png|jpg|webp)$`,
);
const MARKET_STRUCTURE_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
]);
const MARKET_STRUCTURE_SCHEMA_VERSION = 'market-structure-v4';
const MARKET_STRUCTURE_CHART_METRICS_VERSION = 'market-structure-chart-metrics-v2';
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const MARKET_STRUCTURE_WRAPPER_PATTERNS = [
  /having trouble viewing this email/i,
  /view (?:it|this email) in your browser/i,
  /prepared exclusively for/i,
  /the research note below was written by/i,
  /presented by hedgeye/i,
  /to access the full (?:market situation )?report/i,
  /click here/i,
  /manage preferences/i,
  /unsubscribe/i,
  /legal disclaimer/i,
  /important disclosures/i,
  /all rights reserved/i,
];

function isIsoDate(value) {
  const normalized = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return false;
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === normalized;
}

function redactSubscriberText(value) {
  if (typeof value !== 'string') return value;
  return value.replace(EMAIL_PATTERN, '').replace(/[ \t]{2,}/g, ' ').trim();
}

function isMarketStructureWrapperText(value) {
  const text = redactSubscriberText(String(value || '')).trim();
  if (!text) return true;
  if (MARKET_STRUCTURE_WRAPPER_PATTERNS.some((pattern) => pattern.test(text))) return true;
  if (/^by\s+[a-z][a-z'.-]+(?:\s+[a-z][a-z'.-]+){0,3}$/i.test(text)) return true;
  if (/^craig\s+peterson(?:\s*[|·,-].*)?$/i.test(text)) return true;
  if (/^market situation report\s*:/i.test(text)) return true;
  return /^\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}\s+[ap]m(?:\s+[a-z]{2,5})?$/i.test(text);
}

function cleanMarketStructureBodyText(value) {
  if (typeof value !== 'string') return null;
  const blocks = value
    .split(/\n{2,}/)
    .map((block) => redactSubscriberText(block).trim())
    .filter((block) => block && !isMarketStructureWrapperText(block));
  return blocks.join('\n\n') || null;
}

function legacyChartUrl(value) {
  if (!value) return null;
  try {
    const parsed = new URL(String(value));
    if (
      parsed.protocol !== 'https:'
      || parsed.hostname !== 'd1yhils6iwh5l5.cloudfront.net'
    ) return null;
    return `${parsed.protocol}//${parsed.hostname}${parsed.pathname}`;
  } catch {
    return null;
  }
}

function publicChart(chart, date) {
  if (!chart || typeof chart !== 'object') return null;
  const id = String(chart.id || chart.sha256 || '').trim().toLowerCase();
  const archived = MARKET_STRUCTURE_CHART_ID_PATTERN.test(id)
    && typeof chart.s3Key === 'string'
    && MARKET_STRUCTURE_ASSET_KEY_PATTERN.test(chart.s3Key);
  const contentUrl = archived && isIsoDate(date)
    ? `/api/hedgeye/market-structure/${date}/charts/${id}`
    : legacyChartUrl(chart.url || chart.contentUrl);
  if (!contentUrl) return null;
  return {
    ...(MARKET_STRUCTURE_CHART_ID_PATTERN.test(id) ? { id } : {}),
    name: redactSubscriberText(String(chart.name || 'Market Situation chart')),
    ...(MARKET_STRUCTURE_CHART_ID_PATTERN.test(String(chart.sha256 || '').toLowerCase())
      ? { sha256: String(chart.sha256).toLowerCase() }
      : {}),
    ...(MARKET_STRUCTURE_CONTENT_TYPES.has(chart.contentType)
      ? { contentType: chart.contentType }
      : {}),
    contentUrl,
  };
}

function publicArticle(article, charts) {
  const source = article && typeof article === 'object' ? article : {};
  const sanitized = { charts };
  const reportHeading = redactSubscriberText(String(source.reportHeading || '')).trim();
  const bodyText = cleanMarketStructureBodyText(source.bodyText);
  if (reportHeading && !isMarketStructureWrapperText(reportHeading)) {
    sanitized.reportHeading = reportHeading;
  }
  if (bodyText) sanitized.bodyText = bodyText;
  return sanitized;
}

function publicBlocks(blocks, chartIds) {
  if (!Array.isArray(blocks)) return [];
  return blocks.flatMap((block, index) => {
    if (!block || typeof block !== 'object') return [];
    const type = String(block.type || '').trim();
    const id = redactSubscriberText(String(block.id || `block-${index + 1}`));
    if (type === 'chart') {
      const chartId = String(block.chartId || '').trim().toLowerCase();
      if (!chartIds.has(chartId)) return [];
      const caption = redactSubscriberText(String(block.caption || ''));
      return [{
        id,
        type,
        chartId,
        ...(caption && !isMarketStructureWrapperText(caption) ? { caption } : {}),
      }];
    }
    if (!['heading', 'callout', 'paragraph'].includes(type)) return [];
    const text = redactSubscriberText(String(block.text || ''));
    if (!text || isMarketStructureWrapperText(text)) return [];
    return [{ id, type, text }];
  });
}

function finiteMetric(value, minimum, maximum) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : null;
}

function publicChartMetrics(payload, chartIds) {
  if (payload?.schemaVersion !== MARKET_STRUCTURE_SCHEMA_VERSION || payload?.contentComplete !== true) {
    return {};
  }
  const source = payload?.data?.chartMetrics;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
  const commonMetric = (metric) => {
    const chartId = String(metric?.chartId || '').trim().toLowerCase();
    const chartDate = String(metric?.chartDate || '').trim();
    if (
      metric?.extractionBasis !== 'labeled-chart-ocr'
      || metric?.parserVersion !== MARKET_STRUCTURE_CHART_METRICS_VERSION
      || !chartIds.has(chartId)
      || !isIsoDate(chartDate)
    ) return null;
    const rawSourceLabel = redactSubscriberText(String(metric?.source || '')).slice(0, 120);
    const sourceLabel = /^[A-Za-z0-9.-]+$/.test(rawSourceLabel) ? rawSourceLabel : '';
    return {
      chartId,
      chartDate,
      extractionBasis: 'labeled-chart-ocr',
      parserVersion: MARKET_STRUCTURE_CHART_METRICS_VERSION,
      ...(sourceLabel ? { source: sourceLabel } : {}),
    };
  };

  const result = {};
  const throttle = source.spxGammaVolatilityThrottle;
  const throttleCommon = commonMetric(throttle);
  const gammaThrottle = finiteMetric(throttle?.gammaThrottle, -250, 250);
  const tenDayRealizedVolatility = finiteMetric(throttle?.tenDayRealizedVolatility, 0, 250);
  if (throttleCommon && gammaThrottle != null && tenDayRealizedVolatility != null) {
    result.spxGammaVolatilityThrottle = {
      id: 'spxGammaVolatilityThrottle',
      label: 'SPX Gamma Volatility Throttle',
      gammaThrottle,
      tenDayRealizedVolatility,
      ...throttleCommon,
    };
  }

  const gammaMap = source.spxProbableVolatilityGamma;
  const gammaMapCommon = commonMetric(gammaMap);
  const zeroGamma = finiteMetric(gammaMap?.zeroGamma, 100, 100_000);
  const upperPvBand = finiteMetric(gammaMap?.upperPvBand, 100, 100_000);
  const lowerPvBand = finiteMetric(gammaMap?.lowerPvBand, 100, 100_000);
  const strikesInPlay = Array.isArray(gammaMap?.strikesInPlay)
    ? gammaMap.strikesInPlay.map((value) => finiteMetric(value, 100, 100_000)).filter((value) => value != null)
    : [];
  if (
    gammaMapCommon
    && zeroGamma != null
    && upperPvBand != null
    && lowerPvBand != null
    && lowerPvBand < upperPvBand
    && strikesInPlay.length > 0
    && strikesInPlay.length <= 20
    && strikesInPlay.length === gammaMap.strikesInPlay.length
  ) {
    result.spxProbableVolatilityGamma = {
      id: 'spxProbableVolatilityGamma',
      label: 'SPX Probable Volatility / Gamma By Strike',
      zeroGamma,
      upperPvBand,
      lowerPvBand,
      strikesInPlay,
      ...gammaMapCommon,
    };
  }
  return result;
}

function buildPublicMarketStructureSnapshot(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const date = String(payload.date || '').trim();
  const sourceCharts = Array.isArray(payload.data?.charts)
    ? payload.data.charts
    : Array.isArray(payload.article?.charts)
      ? payload.article.charts
      : [];
  const charts = sourceCharts.map((chart) => publicChart(chart, date)).filter(Boolean);
  const chartIds = new Set(charts.map((chart) => chart.id).filter(Boolean));
  const blocks = publicBlocks(payload.data?.blocks, chartIds);
  const signalMatrixChartId = String(payload.data?.signalMatrixChartId || '').trim().toLowerCase();
  const signalMatrix = charts.find((chart) => chart.id === signalMatrixChartId) || charts[0] || null;
  const chartMetrics = publicChartMetrics(payload, chartIds);

  const response = {
    ...payload,
    schemaVersion: payload.schemaVersion || null,
    contentComplete: payload.contentComplete === true,
    article: publicArticle(payload.article, charts),
    data: {
      signals: Array.isArray(payload.data?.signals) ? payload.data.signals : [],
      chartMetrics,
      charts,
      blocks,
      ...(signalMatrix?.id ? { signalMatrixChartId: signalMatrix.id } : {}),
      ...(signalMatrix?.contentUrl ? { signalMatrixImageUrl: signalMatrix.contentUrl } : {}),
    },
  };
  delete response.htmlSource;
  delete response.pdfSource;
  delete response.screenshotS3Key;
  delete response.gmailMessageId;
  return response;
}

function resolveMarketStructureChartAsset(snapshot, date, chartId) {
  if (!isIsoDate(date)) {
    const error = new Error('Market Structure chart date must use YYYY-MM-DD.');
    error.code = 'MARKET_STRUCTURE_DATE_INVALID';
    throw error;
  }
  const normalizedId = String(chartId || '').trim().toLowerCase();
  if (!MARKET_STRUCTURE_CHART_ID_PATTERN.test(normalizedId)) {
    const error = new Error('Market Structure chart ID is invalid.');
    error.code = 'MARKET_STRUCTURE_CHART_ID_INVALID';
    throw error;
  }
  if (
    !snapshot
    || snapshot.snapshotType !== 'market-structure'
    || snapshot.date !== date
    || snapshot.contentComplete !== true
  ) return null;

  const chart = (Array.isArray(snapshot.data?.charts) ? snapshot.data.charts : [])
    .find((candidate) => String(candidate?.id || '').trim().toLowerCase() === normalizedId);
  if (!chart) return null;
  const keyMatch = String(chart.s3Key || '').match(MARKET_STRUCTURE_ASSET_KEY_PATTERN);
  if (
    !keyMatch
    || keyMatch[1] !== normalizedId
    || String(chart.sha256 || '').trim().toLowerCase() !== normalizedId
    || !MARKET_STRUCTURE_CONTENT_TYPES.has(chart.contentType)
  ) return null;
  return {
    id: normalizedId,
    s3Key: chart.s3Key,
    contentType: chart.contentType,
    name: redactSubscriberText(String(chart.name || `market-structure-${normalizedId.slice(0, 12)}`)),
  };
}

function safeInlineFilename(value, contentType) {
  const extension = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
  }[contentType] || '';
  const base = String(value || 'market-structure-chart')
    .replace(/[^A-Za-z0-9._ -]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 120) || 'market-structure-chart';
  return /\.(?:png|jpe?g|webp)$/i.test(base) ? base : `${base}${extension}`;
}

module.exports = {
  MARKET_STRUCTURE_ASSET_PREFIX,
  buildPublicMarketStructureSnapshot,
  isIsoDate,
  resolveMarketStructureChartAsset,
  safeInlineFilename,
};
