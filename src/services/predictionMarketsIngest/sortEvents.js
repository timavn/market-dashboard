const { STATUS_OPEN } = require('./constants');

function statusRank(status) {
  if (STATUS_OPEN.has(status) || status === 'open') return 0;
  if (status === 'paused') return 1;
  if (status === 'closed') return 2;
  return 3;
}

function sortAggregatedEvents(events) {
  return [...events].sort((a, b) => {
    const sr = statusRank(a.status) - statusRank(b.status);
    if (sr !== 0) return sr;

    const da = a.event_date || '9999-12-31';
    const db = b.event_date || '9999-12-31';
    if (da !== db) return da.localeCompare(db);

    const liqA = a.liquidity ?? a.volume ?? 0;
    const liqB = b.liquidity ?? b.volume ?? 0;
    if (liqB !== liqA) return liqB - liqA;

    const spA = a.spread ?? 999;
    const spB = b.spread ?? 999;
    return spA - spB;
  });
}

module.exports = { sortAggregatedEvents };
