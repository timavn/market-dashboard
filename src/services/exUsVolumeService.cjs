const ibkrMarketDataProvider = require('./providers/ibkr/ibkrMarketDataProvider');
const { EX_US_VOLUME_PROXY } = require('../constants/volumeMarkets.cjs');
const { calculateExchangeVolumeMetrics, expectedVolumeTradingDate } = require('../utils/exchangeVolume.cjs');
const { isTradingDateKey } = require('../utils/usEquityMarketCalendar.cjs');
const {
  requiredExUsVolumeDates,
  hasUnverifiedExUsVolumeFlags,
  isVerifiedExUsVolumeContract,
  hasFreshExUsVolumeFetch,
  exUsVolumeMetadata,
  unavailableExUsVolume,
  isVerifiedExUsVolumeResponse,
} = require('../utils/exUsVolume.cjs');

function volumeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function requireConnected(status) {
  if (status?.connected !== true || hasUnverifiedExUsVolumeFlags(status)) {
    throw volumeError('EX_US_VOLUME_PROVIDER_UNAVAILABLE');
  }
}

function createExUsVolumeService({ provider = ibkrMarketDataProvider, now = () => new Date() } = {}) {
  const pending = new Map();

  async function loadSnapshot(targetDate) {
    const before = await provider.getProviderStatus();
    requireConnected(before);
    const history = await provider.getHistoricalBars(EX_US_VOLUME_PROXY.instrument, '2y', '1d', { useRth: true });
    const after = await provider.getProviderStatus();
    requireConnected(after);
    if (before.connectionIdentity != null && after.connectionIdentity != null
      && JSON.stringify(before.connectionIdentity) !== JSON.stringify(after.connectionIdentity)) {
      throw volumeError('EX_US_VOLUME_CONNECTION_CHANGED');
    }
    const verifiedAt = now();
    if (expectedVolumeTradingDate(verifiedAt) !== targetDate) throw volumeError('EX_US_VOLUME_SESSION_CHANGED');
    if (!history || history.source !== 'ibkr' || history.useRth !== true
      || hasUnverifiedExUsVolumeFlags(history) || hasUnverifiedExUsVolumeFlags(history.meta)
      || !isVerifiedExUsVolumeContract(history.contract)
      || !hasFreshExUsVolumeFetch(history.asOf, verifiedAt) || !Array.isArray(history.bars)) {
      throw volumeError('EX_US_VOLUME_UNVERIFIED_HISTORY');
    }
    const latestPossibleDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(verifiedAt));
    const byDate = new Map();
    for (const bar of history.bars) {
      if (!bar || hasUnverifiedExUsVolumeFlags(bar) || !isTradingDateKey(bar.date)
        || bar.date > latestPossibleDate || byDate.has(bar.date)
        || !(typeof bar.volume === 'number' && Number.isFinite(bar.volume) && bar.volume >= 0)) {
        throw volumeError('EX_US_VOLUME_INVALID_DAILY_BAR');
      }
      byDate.set(bar.date, bar.volume > 0 ? bar.volume : null);
    }
    const rows = requiredExUsVolumeDates(targetDate).map(date => ({ date, volume: byDate.get(date) ?? null }));
    const result = {
      asOf: targetDate,
      totalMarket: [],
      totalExchange: rows,
      metrics: { exchange: calculateExchangeVolumeMetrics(rows.map(row => row.volume)) },
      meta: exUsVolumeMetadata(targetDate, history.asOf, 'current', { contract: history.contract }),
    };
    if (!isVerifiedExUsVolumeResponse(result, verifiedAt)) throw volumeError('EX_US_VOLUME_SESSION_UNAVAILABLE');
    return result;
  }

  function fetchSnapshot() {
    const targetDate = expectedVolumeTradingDate(now());
    if (pending.has(targetDate)) return pending.get(targetDate);
    const request = loadSnapshot(targetDate)
      .catch(error => unavailableExUsVolume(targetDate, now(), error.code || 'EX_US_VOLUME_FETCH_FAILED'))
      .finally(() => { pending.delete(targetDate); });
    pending.set(targetDate, request);
    return request;
  }

  return { fetchSnapshot };
}

module.exports = { createExUsVolumeService };
