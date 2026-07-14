const PRODUCT_ORDER = {
  'real-time-alert': 0,
  'risk-ranges': 1,
  'portfolio-solutions': 2,
  'etf-pro': 3,
};

const PRODUCT_LABELS = {
  'real-time-alert': 'Real Time Alerts',
  'risk-ranges': 'Risk Ranges',
  'portfolio-solutions': 'Portfolio Solutions',
  'etf-pro': 'ETF Pro',
};

const FEED_LIMIT = 40;
const MARKET_TIME_ZONE = 'America/New_York';
const DEFAULT_POLL_INTERVAL_MS = 30000;
const POLL_STALE_MULTIPLIER = 2.5;

const ACTION_DISPLAY = {
  ADDED_TO_LONG: 'Added to Long',
  ADDED_TO_SHORT: 'Added to Short',
  SHORT_CLOSED: 'Short -> Closed',
  LONG_CLOSED: 'Long -> Closed',
  DOUBLING_LONG: 'Doubling Long',
  DOUBLING_SHORT: 'Doubling Short',
  ADDED_TO_BULLISH: 'Added to Bullish',
  BULLISH_CLOSED: 'Bullish -> Closed',
  ADDED_TO_BEARISH: 'Added to Bearish',
  BEARISH_CLOSED: 'Bearish -> Closed',
  ADDED_TO_RISK_RANGES: 'Added to Risk Ranges',
  REMOVED_FROM_RISK_RANGES: 'Removed from Risk Ranges',
  REMOVED: 'Removed',
  ALERT: 'Alert',
};

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function parseTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.getTime();
}

function normalizeNow(value) {
  const parsed = parseTimestamp(value || Date.now());
  return parsed || Date.now();
}

export function getHedgeyeMarketDate(value = Date.now()) {
  const timestamp = normalizeNow(value);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: MARKET_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestamp));
  const partMap = parts.reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return `${partMap.year}-${partMap.month}-${partMap.day}`;
}

function formatDateEventTime(value) {
  if (!value) return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return `${value}T12:00:00-04:00`;
  }
  return value;
}

function bestEventTime(...values) {
  return values.find((value) => value != null && value !== '') || null;
}

function itemTimestamp(item) {
  return parseTimestamp(
    item?.eventTime ||
    item?.timestamp ||
    item?.sentAt ||
    item?.receivedAt ||
    item?.scrapedAt ||
    item?.createdAt ||
    item?.updatedAt ||
    formatDateEventTime(item?.currentDate) ||
    item?.date,
  );
}

function eventMarketDate(value) {
  const timestamp = parseTimestamp(value);
  return timestamp ? getHedgeyeMarketDate(timestamp) : null;
}

function itemMarketDate(item) {
  if (typeof item?.currentDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.currentDate)) {
    return item.currentDate;
  }
  return eventMarketDate(item?.eventTime || item?.timestamp);
}

function isCurrentMarketDayItem(item, marketDate) {
  return itemMarketDate(item) === marketDate;
}

function extractTicker(value) {
  if (value == null) return '';
  if (typeof value === 'object') {
    return String(value.ticker || value.symbol || value.asset || value.name || '').trim().toUpperCase();
  }

  const text = String(value).trim();
  const parenMatch = text.match(/\(([A-Z0-9./_-]{1,12})\)/i);
  if (parenMatch) return parenMatch[1].toUpperCase();

  const firstToken = text
    .replace(/^OUTBUCKET:\s*/i, '')
    .match(/[A-Z0-9./_-]{1,12}/i);
  return firstToken ? firstToken[0].toUpperCase() : text.toUpperCase();
}

function normalizeTrend(value) {
  const trend = String(value || '').trim().toUpperCase();
  if (trend === 'BULLISH' || trend === 'BEARISH' || trend === 'NEUTRAL') return trend;
  return trend || 'NEUTRAL';
}

function displayTrend(value) {
  return normalizeTrend(value).toLowerCase();
}

function sentenceTrend(value) {
  const lower = displayTrend(value);
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function actionTone(actionKey, fallback = 'neutral') {
  if (
    actionKey === 'SHORT_CLOSED' ||
    actionKey === 'LONG_CLOSED' ||
    actionKey === 'ADDED_TO_SHORT' ||
    actionKey === 'ADDED_TO_BEARISH' ||
    actionKey === 'BULLISH_CLOSED' ||
    actionKey === 'BEARISH_CLOSED' ||
    actionKey === 'REMOVED_FROM_RISK_RANGES' ||
    actionKey === 'REMOVED'
  ) {
    return 'negative';
  }
  if (
    actionKey === 'ADDED_TO_LONG' ||
    actionKey === 'DOUBLING_LONG' ||
    actionKey === 'ADDED_TO_BULLISH' ||
    actionKey === 'ADDED_TO_RISK_RANGES'
  ) {
    return 'positive';
  }
  return fallback;
}

function trendTone(trend) {
  const normalized = normalizeTrend(trend);
  if (normalized === 'BULLISH') return 'positive';
  if (normalized === 'BEARISH') return 'negative';
  return 'neutral';
}

function productEventTime(diff) {
  return bestEventTime(
    diff?.eventTime,
    diff?.publishedAt,
    diff?.scrapedAt,
    diff?.updatedAt,
    formatDateEventTime(diff?.currentDate || diff?.date),
  );
}

function formatLatestDateDetail(diff) {
  const rawDate = diff?.currentDate || diff?.date || diff?.lastUpdated || productEventTime(diff);
  if (!rawDate) return 'No updates today';
  const timestamp = parseTimestamp(formatDateEventTime(rawDate));
  if (!timestamp) return 'No updates today';
  const label = new Intl.DateTimeFormat('en-US', {
    timeZone: MARKET_TIME_ZONE,
    month: 'short',
    day: 'numeric',
  }).format(new Date(timestamp));
  return `No updates today; latest ${label}`;
}

function buildItem({
  productKey,
  ticker,
  actionKey,
  source,
  description,
  currentDate,
  eventTime,
  tone,
  trendFrom,
  trendTo,
}) {
  const cleanTicker = extractTicker(ticker);
  const displayAction = ACTION_DISPLAY[actionKey] || ACTION_DISPLAY.ALERT;
  const cleanDescription = String(description || `${cleanTicker} update`).trim();
  const timeValue = eventTime || formatDateEventTime(currentDate) || null;

  return {
    id: [
      productKey,
      cleanTicker,
      actionKey || displayAction,
      cleanDescription,
      timeValue || 'no-date',
    ].join(':'),
    productKey,
    productOrder: PRODUCT_ORDER[productKey] ?? 99,
    ticker: cleanTicker || 'UPDATE',
    actionKey: actionKey || 'ALERT',
    actionLabel: displayAction,
    displayAction,
    tone: tone || actionTone(actionKey),
    source,
    description: cleanDescription,
    currentDate: currentDate || null,
    eventTime: timeValue,
    timestamp: timeValue,
    sortTime: parseTimestamp(timeValue) || 0,
    trendFrom: trendFrom ? displayTrend(trendFrom) : null,
    trendTo: trendTo ? displayTrend(trendTo) : null,
  };
}

function inferRtaAction(alert) {
  const text = [
    alert?.actionLabel,
    alert?.signalPhrase,
    alert?.headline,
    alert?.action,
    alert?.side,
  ].filter(Boolean).join(' ').toUpperCase();

  if (/DOUBL/.test(text) && /SHORT/.test(text)) return 'DOUBLING_SHORT';
  if (/DOUBL/.test(text) && /LONG/.test(text)) return 'DOUBLING_LONG';
  if (/REMOV|CLOS|COVER/.test(text) && /SHORT/.test(text)) return 'SHORT_CLOSED';
  if (/REMOV|CLOS|SELL/.test(text) && /LONG/.test(text)) return 'LONG_CLOSED';
  if (/ADD|BUY/.test(text) && /SHORT/.test(text)) return 'ADDED_TO_SHORT';
  if (/ADD|BUY/.test(text) && /LONG/.test(text)) return 'ADDED_TO_LONG';
  if (/BUY/.test(text)) return 'ADDED_TO_LONG';
  if (/SELL/.test(text)) return 'LONG_CLOSED';
  return 'ALERT';
}

function rtaDescription(ticker, actionKey, fallback) {
  if (actionKey === 'ADDED_TO_LONG') return `${ticker} added to Long`;
  if (actionKey === 'ADDED_TO_SHORT') return `${ticker} added to Short`;
  if (actionKey === 'SHORT_CLOSED') return `${ticker} removed from Short`;
  if (actionKey === 'LONG_CLOSED') return `${ticker} removed from Long`;
  if (actionKey === 'DOUBLING_LONG') return `${ticker} doubled in Long`;
  if (actionKey === 'DOUBLING_SHORT') return `${ticker} doubled in Short`;
  return fallback || `${ticker} alert`;
}

function mapRta(changelog) {
  const diff = changelog?.['real-time-alert'] || {};
  const fallbackEventTime = productEventTime(diff);
  const alerts = asArray(diff.alerts);
  return alerts.map((alert, index) => {
    const ticker = extractTicker(alert?.ticker || alert?.symbol || alert?.headline || alert?.signalPhrase || `RTA-${index}`);
    const actionKey = inferRtaAction(alert);
    return buildItem({
      productKey: 'real-time-alert',
      ticker,
      actionKey,
      source: PRODUCT_LABELS['real-time-alert'],
      description: rtaDescription(ticker, actionKey, alert?.signalPhrase || alert?.headline),
      currentDate: diff.currentDate || alert?.date,
      eventTime: bestEventTime(alert?.eventTime, alert?.timestamp, alert?.sentAt, alert?.receivedAt, alert?.scrapedAt, fallbackEventTime),
      tone: actionTone(actionKey),
    });
  });
}

function mapPortfolioSolutions(changelog) {
  const diff = changelog?.['portfolio-solutions'] || {};
  const eventTime = productEventTime(diff);
  const currentDate = diff.currentDate || diff.date;
  const added = asArray(diff.added).map((item) => {
    const ticker = extractTicker(item);
    return buildItem({
      productKey: 'portfolio-solutions',
      ticker,
      actionKey: 'ADDED_TO_LONG',
      source: PRODUCT_LABELS['portfolio-solutions'],
      description: `${ticker} added to Portfolio Solutions`,
      currentDate,
      eventTime,
      tone: 'positive',
    });
  });
  const removed = asArray(diff.removed).map((item) => {
    const ticker = extractTicker(item);
    return buildItem({
      productKey: 'portfolio-solutions',
      ticker,
      actionKey: 'REMOVED',
      source: PRODUCT_LABELS['portfolio-solutions'],
      description: `${ticker} removed from Portfolio Solutions`,
      currentDate,
      eventTime,
      tone: 'negative',
    });
  });
  return [...added, ...removed];
}

function mapEtfPro(changelog) {
  const diff = changelog?.['etf-pro'] || {};
  const eventTime = productEventTime(diff);
  const currentDate = diff.currentDate || diff.date;
  const groups = [
    ['addedLongs', 'ADDED_TO_BULLISH', 'added to ETF Pro Bullish', 'positive'],
    ['removedLongs', 'BULLISH_CLOSED', 'removed from ETF Pro Bullish', 'negative'],
    ['addedShorts', 'ADDED_TO_BEARISH', 'added to ETF Pro Bearish', 'negative'],
    ['removedShorts', 'BEARISH_CLOSED', 'removed from ETF Pro Bearish', 'negative'],
  ];

  return groups.flatMap(([key, actionKey, phrase, tone]) =>
    asArray(diff[key]).map((tickerValue) => {
      const ticker = extractTicker(tickerValue);
      return buildItem({
        productKey: 'etf-pro',
        ticker,
        actionKey,
        source: PRODUCT_LABELS['etf-pro'],
        description: `${ticker} ${phrase}`,
        currentDate,
        eventTime,
        tone,
      });
    }),
  );
}

function mapRiskRanges(changelog) {
  const diff = changelog?.['risk-ranges'] || {};
  const eventTime = productEventTime(diff);
  const currentDate = diff.currentDate || diff.date;
  const trendChanges = asArray(diff.trendChanges).map((change) => {
    const ticker = extractTicker(change?.ticker || change?.symbol || change?.asset || change?.name);
    const oldTrend = normalizeTrend(change?.oldTrend || change?.oldValue || change?.from);
    const newTrend = normalizeTrend(change?.newTrend || change?.newValue || change?.to);
    return buildItem({
      productKey: 'risk-ranges',
      ticker,
      actionKey: 'TREND_CHANGE',
      source: PRODUCT_LABELS['risk-ranges'],
      description: `${ticker} trend changed from ${sentenceTrend(oldTrend)} to ${sentenceTrend(newTrend)}`,
      currentDate,
      eventTime: bestEventTime(change?.eventTime, change?.scrapedAt, eventTime),
      tone: trendTone(newTrend),
      trendFrom: oldTrend,
      trendTo: newTrend,
    });
  });

  const added = [...asArray(diff.added), ...asArray(diff.outbucketDiff?.added)].map((item) => {
    const ticker = extractTicker(item);
    return buildItem({
      productKey: 'risk-ranges',
      ticker,
      actionKey: 'ADDED_TO_RISK_RANGES',
      source: PRODUCT_LABELS['risk-ranges'],
      description: `${ticker} added to Risk Ranges`,
      currentDate,
      eventTime,
      tone: 'positive',
    });
  });

  const removed = [...asArray(diff.removed), ...asArray(diff.outbucketDiff?.removed)].map((item) => {
    const ticker = extractTicker(item);
    return buildItem({
      productKey: 'risk-ranges',
      ticker,
      actionKey: 'REMOVED_FROM_RISK_RANGES',
      source: PRODUCT_LABELS['risk-ranges'],
      description: `${ticker} removed from Risk Ranges`,
      currentDate,
      eventTime,
      tone: 'negative',
    });
  });

  return [...trendChanges, ...added, ...removed];
}

function buildRawFeedItems(changelog) {
  if (!changelog || typeof changelog !== 'object' || Array.isArray(changelog)) return [];

  return [
    ...mapRta(changelog),
    ...mapRiskRanges(changelog),
    ...mapPortfolioSolutions(changelog),
    ...mapEtfPro(changelog),
  ]
    .filter((item) => item && item.ticker && item.displayAction)
    .sort((a, b) => {
      if (b.sortTime !== a.sortTime) return b.sortTime - a.sortTime;
      if (a.productOrder !== b.productOrder) return a.productOrder - b.productOrder;
      return a.ticker.localeCompare(b.ticker);
    });
}

function normalizeFeedOptions(optionsOrLimit) {
  if (typeof optionsOrLimit === 'number') {
    return {
      limit: optionsOrLimit,
      now: Date.now(),
      marketDate: getHedgeyeMarketDate(),
    };
  }

  const options = optionsOrLimit || {};
  const now = normalizeNow(options.now);
  return {
    limit: options.limit ?? FEED_LIMIT,
    now,
    marketDate: options.marketDate || getHedgeyeMarketDate(now),
  };
}

export function buildHedgeyeLatestUpdatesFeed(changelog, optionsOrLimit = {}) {
  const { limit, marketDate } = normalizeFeedOptions(optionsOrLimit);
  return buildRawFeedItems(changelog)
    .filter((item) => isCurrentMarketDayItem(item, marketDate))
    .slice(0, limit);
}

function countItemsByProduct(items) {
  return items.reduce((acc, item) => {
    acc[item.productKey] = (acc[item.productKey] || 0) + 1;
    return acc;
  }, {});
}

export function buildHedgeyeLatestUpdatesStatus(
  changelog,
  {
    error = null,
    now = Date.now(),
    lastSuccessAt = null,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    marketDate,
  } = {},
) {
  const keys = ['real-time-alert', 'risk-ranges', 'portfolio-solutions', 'etf-pro'];
  const currentMarketDate = marketDate || getHedgeyeMarketDate(now);
  const currentItems = buildHedgeyeLatestUpdatesFeed(changelog, {
    limit: Number.POSITIVE_INFINITY,
    now,
    marketDate: currentMarketDate,
  });
  const countsByProduct = countItemsByProduct(currentItems);
  const lastSuccessMs = parseTimestamp(lastSuccessAt);
  const nowMs = normalizeNow(now);
  const pollIsStale = lastSuccessMs ? nowMs - lastSuccessMs > pollIntervalMs * POLL_STALE_MULTIPLIER : false;
  const hasCurrentItems = currentItems.length > 0;

  const overallStatus = (() => {
    if (error || !lastSuccessMs) return 'inactive';
    if (pollIsStale) return 'stale';
    if (!hasCurrentItems) return 'inactive';
    return 'active';
  })();

  const sources = keys.map((key) => {
    const diff = changelog?.[key] || {};
    const count = countsByProduct[key] || 0;
    const updatedAt = lastSuccessAt || productEventTime(diff);
    const sourceStatus = error
      ? 'defective'
      : pollIsStale
        ? 'stale'
        : 'current';
    return {
      id: `hedgeye-updates:${key}`,
      label: PRODUCT_LABELS[key],
      updatedAt,
      status: sourceStatus,
      detail: count > 0 ? `${count} update${count === 1 ? '' : 's'}` : formatLatestDateDetail(diff),
    };
  });

  const updatedTimes = sources
    .map((source) => parseTimestamp(source.updatedAt))
    .filter((value) => Number.isFinite(value));
  const newestUpdatedAt = updatedTimes.length > 0
    ? new Date(Math.max(...updatedTimes)).toISOString()
    : null;
  const emoji = overallStatus === 'active' ? '🟢' : overallStatus === 'stale' ? '🟡' : '🔴';

  return {
    updatedAt: lastSuccessAt || newestUpdatedAt,
    status: overallStatus,
    emoji,
    label: 'Latest Hedgeye updates',
    overallLabel: 'Latest Updates',
    sources,
  };
}

export function formatHedgeyeFeedTime(item, now = Date.now()) {
  const timestamp = itemTimestamp(item);
  if (!timestamp) return '';
  const deltaMs = now - timestamp;
  if (deltaMs >= 0 && deltaMs < 60 * 60 * 1000) {
    const minutes = Math.max(1, Math.round(deltaMs / 60000));
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }
  if (deltaMs >= 0 && deltaMs < 24 * 60 * 60 * 1000) {
    const hours = Math.max(1, Math.round(deltaMs / 3600000));
    return `${hours === 1 ? 'about ' : ''}${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export const HEDGEYE_LATEST_UPDATES_LIMIT = FEED_LIMIT;
