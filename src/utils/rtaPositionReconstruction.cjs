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

function summarizeRealTimeAlertPositions(snapshots, { windowDays = 90 } = {}) {
  const orderedSnapshots = Array.isArray(snapshots)
    ? [...snapshots].sort((a, b) => {
        const dateCompare = String(a?.date || '').localeCompare(String(b?.date || ''));
        if (dateCompare !== 0) return dateCompare;
        return String(a?.scrapedAt || '').localeCompare(String(b?.scrapedAt || ''));
      })
    : [];

  const positionMap = new Map();
  let lastUpdated = null;

  orderedSnapshots.forEach((snapshot) => {
    const date = snapshot?.date || null;
    const alerts = normalizeRealTimeAlerts(snapshot);

    alerts.forEach((alert) => {
      const ticker = normalizeTicker(alert?.ticker);
      const action = String(alert?.action || '').toUpperCase();
      if (!ticker || !action) return;

      const eventTime = getAlertTime(alert, date);
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
        const existing = positionMap.get(ticker);
        if (existing?.side === 'long' && alert?.intent !== 'open-short') {
          positionMap.delete(ticker);
          return;
        }
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
          positionMap.set(ticker, {
            ...existing,
            lastActionAt: eventTime,
          });
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
    longCount,
    shortCount,
    ratioText: formatRatioText(longCount, shortCount),
    netBias: deriveNetBias(longCount, shortCount),
    holdings,
  };
}

module.exports = {
  normalizeRealTimeAlerts,
  summarizeRealTimeAlertPositions,
  formatRatioText,
  deriveNetBias,
};
