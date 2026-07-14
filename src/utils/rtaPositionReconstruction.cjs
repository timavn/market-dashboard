function normalizeRealTimeAlerts(snapshot) {
  const data = snapshot?.data || {};
  if (Array.isArray(data.alerts)) return data.alerts.filter(Boolean);
  if (data.alert) return [data.alert].filter(Boolean);
  return [];
}

function normalizeTicker(rawTicker) {
  if (!rawTicker) return null;
  const cleaned = String(rawTicker).trim().toUpperCase();
  return cleaned || null;
}

function getAlertTime(alert, snapshotDate) {
  return alert?.eventTime || alert?.receivedAt || alert?.scrapedAt || snapshotDate || null;
}

function openPosition(positionMap, ticker, side, alert, snapshotDate) {
  const existing = positionMap.get(ticker);
  const eventTime = getAlertTime(alert, snapshotDate);
  positionMap.set(ticker, {
    ticker,
    side,
    name: alert?.name || ticker,
    openedAt: existing?.side === side ? existing.openedAt : eventTime,
    lastActionAt: eventTime,
  });
}

function formatRatioText(longCount, shortCount) {
  if (!longCount && !shortCount) return 'No holdings';
  if (!shortCount) return `${longCount}:0`;
  if (!longCount) return `0:${shortCount}`;
  return `${(longCount / shortCount).toFixed(1)}:1`;
}

function deriveNetBias(longCount, shortCount) {
  if (longCount === shortCount) return 'balanced';
  return longCount > shortCount ? 'long' : 'short';
}

function getTimeMs(value) {
  if (!value) return 0;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

function seedBaselinePositions(positionMap, baseline = {}) {
  const asOf = baseline.asOf || baseline.lastUpdated || null;
  const positions = Array.isArray(baseline.holdings)
    ? baseline.holdings
    : [
        ...(Array.isArray(baseline.longs)
          ? baseline.longs.map((ticker) => ({ ticker, side: 'long' }))
          : []),
        ...(Array.isArray(baseline.shorts)
          ? baseline.shorts.map((ticker) => ({ ticker, side: 'short' }))
          : []),
      ];

  positions.forEach((position) => {
    const ticker = normalizeTicker(position?.ticker || position);
    const side = String(position?.side || '').toLowerCase() === 'short' ? 'short' : 'long';
    if (!ticker) return;
    positionMap.set(ticker, {
      ticker,
      side,
      name: position?.name || ticker,
      openedAt: position?.openedAt || asOf,
      lastActionAt: position?.lastActionAt || asOf,
      source: position?.source || 'rta-benchmark',
    });
  });

  return asOf;
}

function normalizeAction(rawAction) {
  const action = String(rawAction || '').toUpperCase().replace(/\s+/g, '-');
  if (action === 'COVER-SOME') return 'COVER';
  return action;
}

function summarizeRealTimeAlertPositions(snapshots, { windowDays = 90, baseline = null } = {}) {
  const orderedSnapshots = Array.isArray(snapshots)
    ? [...snapshots].sort((a, b) => {
        const dateCompare = String(a?.date || '').localeCompare(String(b?.date || ''));
        if (dateCompare !== 0) return dateCompare;
        return String(a?.scrapedAt || '').localeCompare(String(b?.scrapedAt || ''));
      })
    : [];

  const positionMap = new Map();
  const baselineAsOf = baseline ? seedBaselinePositions(positionMap, baseline) : null;
  const baselineAsOfMs = getTimeMs(baselineAsOf);
  let lastUpdated = baselineAsOf || null;

  orderedSnapshots.forEach((snapshot) => {
    const date = snapshot?.date || null;
    const alerts = normalizeRealTimeAlerts(snapshot);

    alerts.forEach((alert) => {
      const ticker = normalizeTicker(alert?.ticker);
      const action = normalizeAction(alert?.action);
      if (!ticker || !action) return;

      const eventTime = getAlertTime(alert, date);
      if (baselineAsOfMs > 0 && getTimeMs(eventTime || date) <= baselineAsOfMs) {
        return;
      }
      if (eventTime) {
        lastUpdated = eventTime;
      }

      if (action === 'BUY') {
        const existing = positionMap.get(ticker);
        if (existing?.side === 'short' && alert?.intent !== 'open-long') {
          positionMap.delete(ticker);
          return;
        }
        openPosition(positionMap, ticker, 'long', alert, date);
        return;
      }

      if (action === 'SELL') {
        openPosition(positionMap, ticker, 'short', alert, date);
        return;
      }

      if (action === 'COVER') {
        const existing = positionMap.get(ticker);
        if (existing?.side === 'short') {
          positionMap.delete(ticker);
        }
        return;
      }

      if (action === 'SELL-SOME') {
        const existing = positionMap.get(ticker);
        if (existing?.side === 'long') {
          positionMap.delete(ticker);
        }
        return;
      }

      if (action === 'ADD') {
        const side = alert?.side === 'short' ? 'short' : 'long';
        openPosition(positionMap, ticker, side, alert, date);
        return;
      }

      if (action === 'REMOVE') {
        const existing = positionMap.get(ticker);
        if (!existing || !alert?.side || existing.side === alert.side) {
          positionMap.delete(ticker);
        }
      }
    });
  });

  const holdings = Array.from(positionMap.values()).sort((a, b) => {
    if (a.side !== b.side) return a.side === 'long' ? -1 : 1;
    return a.ticker.localeCompare(b.ticker);
  });

  const longCount = holdings.filter((holding) => holding.side === 'long').length;
  const shortCount = holdings.filter((holding) => holding.side === 'short').length;

  return {
    available: holdings.length > 0,
    lastUpdated,
    windowDays,
    positionSource: 'alert-reconstruction',
    positionSourceConfidence: 'high',
    baseline: baseline
      ? {
          id: baseline.id || null,
          asOf: baselineAsOf,
          source: baseline.source || 'rta-benchmark',
        }
      : null,
    reconstructionWarnings: [],
    longCount,
    shortCount,
    ratioText: formatRatioText(longCount, shortCount),
    netBias: deriveNetBias(longCount, shortCount),
    holdings,
  };
}

module.exports = {
  seedBaselinePositions,
  normalizeRealTimeAlerts,
  summarizeRealTimeAlertPositions,
  formatRatioText,
  deriveNetBias,
};
