// Only broker-verified lifecycles are allowed through the public P&L read
// boundary. Legacy user-confirmed and review records remain durable audit
// evidence, but they must never be presented as authoritative performance.
const DISPLAY_STATUSES = new Set(['verified']);
const PERFORMANCE_MARKET_KEYS = Object.freeze(['wti', 'gold', 'sp500', 'nasdaq100', 'bitcoin', 'ethereum', 'cpi']);

function text(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeMarket(value, source = '') {
  const raw = `${text(value)} ${text(source)}`.toLowerCase();
  if (/kxcpi|cpiy|inflation|consumer price|\bcpi\b/.test(raw)) return 'cpi';
  if (/kxbtc|\bbrti\b|\bbitcoin\b|\bbtc\b/.test(raw)) return 'bitcoin';
  if (/kxeth|ethusd|\berti\b|\bethereum\b|\beth\b/.test(raw)) return 'ethereum';
  if (/kxgold|metlg|\bgold\b|\bgcq|\bgld\b/.test(raw)) return 'gold';
  if (/fnq|\bnasdaq|\bnqu|\bndx\b|\bnq\b/.test(raw)) return 'nasdaq100';
  if (/kxinx|fes[_-]|\bspx\b|\bsp500\b|s&p|s\s*p\s*500|\besu/.test(raw)) return 'sp500';
  if (/kxwti|comco|\bwti\b|crude|\boil\b/.test(raw)) return 'wti';
  return 'other';
}

function displayStateFromRecord(record = {}) {
  if (record.status === 'review') return 'CHECK';
  if (DISPLAY_STATUSES.has(record.status)) return record.resolutionType === 'early_exit' ? 'CLOSED' : 'SETTLED';
  if (record.status === 'awaiting_resolution') return 'AWAITING_RESULT';
  if (record.status === 'open') return 'OPEN';
  return 'CHECK';
}

function sortPerformanceRows(rows = [], sort = 'date', direction = 'desc') {
  const multiplier = direction === 'asc' ? 1 : -1;
  return [...rows].sort((left, right) => {
    if (sort === 'status') {
      const statusRank = (row = {}) => {
        const state = text(row.displayState || displayStateFromRecord(row)).toUpperCase();
        return {
          OPEN: 0,
          AWAITING_RESULT: 1,
          CLOSED: 2,
          SETTLED: 3,
          CHECK: 4,
        }[state] ?? 5;
      };
      const rankDifference = statusRank(left) - statusRank(right);
      if (rankDifference) return rankDifference * multiplier;
      const leftMarket = normalizeMarket(left.market, `${left.contractLabel || ''} ${left.contractKey || ''}`);
      const rightMarket = normalizeMarket(right.market, `${right.contractLabel || ''} ${right.contractKey || ''}`);
      const leftMarketRank = PERFORMANCE_MARKET_KEYS.indexOf(leftMarket);
      const rightMarketRank = PERFORMANCE_MARKET_KEYS.indexOf(rightMarket);
      const normalizedLeftRank = leftMarketRank < 0 ? PERFORMANCE_MARKET_KEYS.length : leftMarketRank;
      const normalizedRightRank = rightMarketRank < 0 ? PERFORMANCE_MARKET_KEYS.length : rightMarketRank;
      if (normalizedLeftRank !== normalizedRightRank) return normalizedLeftRank - normalizedRightRank;
      const contractDifference = String(left.contractLabel || left.contractKey || '')
        .localeCompare(String(right.contractLabel || right.contractKey || ''), 'en-US', { numeric: true });
      if (contractDifference) return contractDifference;
      return String(left.id).localeCompare(String(right.id));
    }
    const values = {
      date: [left.openedAt || left.resolvedDate || left.expiration || '', right.openedAt || right.resolvedDate || right.expiration || ''],
      status: [left.status || '', right.status || ''],
      contract: [left.contractLabel || '', right.contractLabel || ''],
      resolutionAt: [left.resolutionAt || left.settlementDate || '', right.resolutionAt || right.settlementDate || ''],
      settlementDate: [left.settlementDate || '', right.settlementDate || ''],
      settlementValue: [left.settlementValue, right.settlementValue],
      risk: [left.risked, right.risked],
      risked: [left.risked, right.risked],
      value: [left.currentValue ?? left.paid, right.currentValue ?? right.paid],
      paid: [left.currentValue ?? left.paid, right.currentValue ?? right.paid],
      pnl: [left.pnl, right.pnl],
      roi: [left.roi, right.roi],
    }[sort] || [left.resolvedDate || left.expiration || '', right.resolvedDate || right.expiration || ''];
    const leftValue = values[0] == null ? (direction === 'asc' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY) : values[0];
    const rightValue = values[1] == null ? (direction === 'asc' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY) : values[1];
    if (leftValue === rightValue) return String(left.id).localeCompare(String(right.id));
    return (leftValue > rightValue ? 1 : -1) * multiplier;
  });
}

module.exports = { DISPLAY_STATUSES, PERFORMANCE_MARKET_KEYS, normalizeMarket, displayStateFromRecord, sortPerformanceRows };
