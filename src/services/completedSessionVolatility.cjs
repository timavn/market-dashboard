const { normalizeAdjustedPriceBars } = require('../utils/securityRiskMetrics.cjs');
const { buildLogReturns, trailingAnnualizedVol } = require('../utils/realizedVolatility.cjs');
const { mostRecentCompletedTradingDateKey } = require('./volatilitySnapshotService.cjs');
const { previousTradingDateKey } = require('../utils/usEquityMarketCalendar.cjs');

const SOURCE = 'Yahoo Finance chart API';
const INVALID_HISTORY_FLAGS = ['mock', 'seed', 'seeded', 'stale', 'cacheOnly', 'offline'];

// A research reading of the completed cash session needs 64 explicit adjusted
// closes, not SPY beta, all-time price structure or a century of index history.
function createCompletedSessionVolatilityHandler({ loadHistory, now = () => new Date() }) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Data-Use', 'historical-research-only');
    const at = now();
    const expectedAsOf = mostRecentCompletedTradingDateKey(at);
    const unavailable = () => ({ status: 'unavailable', source: SOURCE,
      rows: { SPX: { symbol: 'SPX', status: 'unavailable', asOf: null,
        realizedVolatility: { status: 'unavailable', rv21: null, rv63: null, asOf: null } } },
      completedSession: { status: 'unavailable', expectedAsOf, observedAsOf: null },
      historicalOnly: true, executable: false });
    try {
      const history = await loadHistory('SPX', {
        forceRefresh: ['1', 'true'].includes(String(req.query.forceRefresh || '').toLowerCase()),
        cacheScope: 'completed-session-volatility-1y',
        period1: String(Math.floor(at.getTime() / 1000) - 366 * 86400),
        period2: String(Math.floor(at.getTime() / 1000)),
      });
      if (history?.yahooSymbol !== '^GSPC' || history.instrumentType !== 'INDEX'
        || !Number.isFinite(Date.parse(history.fetchedAt))
        || INVALID_HISTORY_FLAGS.some(flag => history[flag] === true)) return res.json(unavailable());
      // Limit the calculation to the independently verified completed session.
      // Missing adjusted closes stay missing; raw close is never a substitute.
      const bars = normalizeAdjustedPriceBars(history.bars)
        .filter(bar => bar.date <= expectedAsOf && bar.adjustedClose > 0)
        .slice(-64);
      const asOf = bars.at(-1)?.date;
      let expectedDate = expectedAsOf;
      for (let i = bars.length - 1; i >= 0; i -= 1) {
        if (bars[i].date !== expectedDate) return res.json(unavailable());
        expectedDate = previousTradingDateKey(expectedDate);
      }
      const returns = buildLogReturns(bars.map(bar => ({ date: bar.date, close: bar.adjustedClose })));
      const oneMonth = trailingAnnualizedVol(returns, 21, 252);
      const threeMonth = trailingAnnualizedVol(returns, 63, 252);
      if (asOf !== expectedAsOf || !oneMonth || !threeMonth) return res.json(unavailable());
      return res.json({ status: 'available', source: SOURCE,
        rows: { SPX: { symbol: 'SPX', status: 'available', asOf,
          realizedVolatility: { status: 'available', rv21: oneMonth.value, rv63: threeMonth.value,
            asOf, annualizationFactor: 252, observationCount: returns.length },
          provenance: { provider: 'Yahoo Finance', dataset: 'chart', interval: '1d',
            adjustedCloseRequired: true, security: { requestedSymbol: 'SPX', yahooSymbol: history.yahooSymbol,
              fetchedAt: history.fetchedAt, cacheStatus: history.cacheStatus,
              cacheAgeSeconds: history.cacheAgeSeconds } }, historicalOnly: true, executable: false } },
        completedSession: { status: 'current', expectedAsOf, observedAsOf: asOf },
        historicalOnly: true, executable: false });
    } catch { return res.json(unavailable()); }
  };
}

module.exports = { createCompletedSessionVolatilityHandler };
