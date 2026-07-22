const PRODUCT_ORDER = {
  'real-time-alert': 0,
  'risk-ranges': 1,
  'portfolio-solutions': 2,
  'etf-pro': 3,
};

const FEED_LIMIT = 40;

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function parseTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.getTime();
}

function itemTimestamp(item) {
  return parseTimestamp(
    item?.timestamp ||
    item?.sentAt ||
    item?.receivedAt ||
    item?.scrapedAt ||
    item?.createdAt ||
    item?.updatedAt ||
    item?.currentDate ||
    item?.date,
  );
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

function stripTickerDecoration(value) {
  return extractTicker(value);
}

function normalizeTrend(value) {
  const trend = String(value || '').trim().toUpperCase();
  if (trend === 'BULLISH' || trend === 'BEARISH' || trend === 'NEUTRAL') return trend;
  return trend || 'NEUTRAL';
}

function toneForLabel(label, fallback = 'neutral') {
  const text = String(label || '').toUpperCase();
  if (text.includes('CLOSED') || text.includes('REMOVED') || text.includes('BEARISH') || text.includes('SHORT')) {
    return 'negative';
  }
  if (text.includes('ADDED') || text.includes('BULLISH') || text.includes('LONG')) {
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

function buildItem({ productKey, ticker, actionLabel, source, description, currentDate, timestamp, tone }) {
  const cleanTicker = extractTicker(ticker);
  const cleanLabel = String(actionLabel || 'UPDATE').trim().toUpperCase();
  const cleanDescription = String(description || `${cleanTicker} update`).trim();
  const timeValue = timestamp || currentDate || null;

  return {
    id: [
      productKey,
      cleanTicker,
      cleanLabel,
      cleanDescription,
      timeValue || 'no-date',
    ].join(':'),
    productKey,
    productOrder: PRODUCT_ORDER[productKey] ?? 99,
    ticker: cleanTicker || 'UPDATE',
    actionLabel: cleanLabel,
    tone: tone || toneForLabel(cleanLabel),
    source,
    description: cleanDescription,
    currentDate: currentDate || null,
    timestamp: timestamp || null,
    sortTime: parseTimestamp(timestamp || currentDate) || 0,
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

  if (/DOUBL/.test(text) && /SHORT/.test(text)) return 'DOUBLING SHORT';
  if (/DOUBL/.test(text) && /LONG/.test(text)) return 'DOUBLING LONG';
  if (/REMOV|CLOS|COVER/.test(text) && /SHORT/.test(text)) return 'SHORT -> CLOSED';
  if (/REMOV|CLOS|SELL/.test(text) && /LONG/.test(text)) return 'LONG -> CLOSED';
  if (/ADD|BUY/.test(text) && /SHORT/.test(text)) return 'ADDED TO SHORT';
  if (/ADD|BUY/.test(text) && /LONG/.test(text)) return 'ADDED TO LONG';
  if (text === 'BUY') return 'ADDED TO LONG';
  if (text === 'SELL') return 'LONG -> CLOSED';
  return String(alert?.action || alert?.actionLabel || 'ALERT').toUpperCase();
}

function mapRta(changelog) {
  const diff = changelog?.['real-time-alert'] || {};
  const alerts = asArray(diff.alerts);
  return alerts.map((alert, index) => {
    const ticker = alert?.ticker || alert?.symbol || alert?.headline || alert?.signalPhrase || `RTA-${index}`;
    const actionLabel = inferRtaAction(alert);
    const description = alert?.signalPhrase || alert?.headline || `${extractTicker(ticker)} ${actionLabel.toLowerCase()}`;
    return buildItem({
      productKey: 'real-time-alert',
      ticker,
      actionLabel,
      source: 'Real Time Alerts',
      description,
      currentDate: diff.currentDate || alert?.date,
      timestamp: alert?.timestamp || alert?.sentAt || alert?.receivedAt || alert?.scrapedAt,
      tone: toneForLabel(actionLabel),
    });
  });
}

function mapPortfolioSolutions(changelog) {
  const diff = changelog?.['portfolio-solutions'] || {};
  const currentDate = diff.currentDate || diff.date;
  const added = asArray(diff.added).map((item) => {
    const ticker = stripTickerDecoration(item);
    return buildItem({
      productKey: 'portfolio-solutions',
      ticker,
      actionLabel: 'ADDED TO LONG',
      source: 'Portfolio Solutions',
      description: `${ticker} added to Portfolio Solutions`,
      currentDate,
      tone: 'positive',
    });
  });
  const removed = asArray(diff.removed).map((item) => {
    const ticker = stripTickerDecoration(item);
    return buildItem({
      productKey: 'portfolio-solutions',
      ticker,
      actionLabel: 'REMOVED',
      source: 'Portfolio Solutions',
      description: `${ticker} removed from Portfolio Solutions`,
      currentDate,
      tone: 'negative',
    });
  });
  return [...added, ...removed];
}

function mapEtfPro(changelog) {
  const diff = changelog?.['etf-pro'] || {};
  const currentDate = diff.currentDate || diff.date;
  const groups = [
    ['addedLongs', 'ADDED TO BULLISH', 'added to ETF Pro Bullish', 'positive'],
    ['removedLongs', 'BULLISH -> CLOSED', 'removed from ETF Pro Bullish', 'negative'],
    ['addedShorts', 'ADDED TO BEARISH', 'added to ETF Pro Bearish', 'negative'],
    ['removedShorts', 'BEARISH -> CLOSED', 'removed from ETF Pro Bearish', 'negative'],
  ];

  return groups.flatMap(([key, actionLabel, phrase, tone]) =>
    asArray(diff[key]).map((tickerValue) => {
      const ticker = stripTickerDecoration(tickerValue);
      return buildItem({
        productKey: 'etf-pro',
        ticker,
        actionLabel,
        source: 'ETF Pro',
        description: `${ticker} ${phrase}`,
        currentDate,
        tone,
      });
    }),
  );
}

function mapRiskRanges(changelog) {
  const diff = changelog?.['risk-ranges'] || {};
  const currentDate = diff.currentDate || diff.date;
  const trendChanges = asArray(diff.trendChanges).map((change) => {
    const ticker = change?.ticker || change?.symbol || change?.asset || change?.name;
    const oldTrend = normalizeTrend(change?.oldTrend || change?.oldValue || change?.from);
    const newTrend = normalizeTrend(change?.newTrend || change?.newValue || change?.to);
    return buildItem({
      productKey: 'risk-ranges',
      ticker,
      actionLabel: `${oldTrend} -> ${newTrend}`,
      source: 'Risk Ranges',
      description: `${extractTicker(ticker)} trend changed from ${oldTrend} to ${newTrend}`,
      currentDate,
      tone: trendTone(newTrend),
    });
  });

  const added = [...asArray(diff.added), ...asArray(diff.outbucketDiff?.added)].map((item) => {
    const ticker = stripTickerDecoration(item);
    return buildItem({
      productKey: 'risk-ranges',
      ticker,
      actionLabel: 'ADDED TO RISK RANGES',
      source: 'Risk Ranges',
      description: `${ticker} added to Risk Ranges`,
      currentDate,
      tone: 'positive',
    });
  });

  const removed = [...asArray(diff.removed), ...asArray(diff.outbucketDiff?.removed)].map((item) => {
    const ticker = stripTickerDecoration(item);
    return buildItem({
      productKey: 'risk-ranges',
      ticker,
      actionLabel: 'REMOVED FROM RISK RANGES',
      source: 'Risk Ranges',
      description: `${ticker} removed from Risk Ranges`,
      currentDate,
      tone: 'negative',
    });
  });

  return [...trendChanges, ...added, ...removed];
}

export function buildHedgeyeLatestUpdatesFeed(changelog, limit = FEED_LIMIT) {
  if (!changelog || typeof changelog !== 'object') return [];

  return [
    ...mapRta(changelog),
    ...mapRiskRanges(changelog),
    ...mapPortfolioSolutions(changelog),
    ...mapEtfPro(changelog),
  ]
    .filter((item) => item && item.ticker && item.actionLabel)
    .sort((a, b) => {
      if (b.sortTime !== a.sortTime) return b.sortTime - a.sortTime;
      if (a.productOrder !== b.productOrder) return a.productOrder - b.productOrder;
      return a.ticker.localeCompare(b.ticker);
    })
    .slice(0, limit);
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
