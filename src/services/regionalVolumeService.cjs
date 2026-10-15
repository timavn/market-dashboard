const {
  EXCHANGE_VOLUME_METHODOLOGY,
  EXCHANGE_VOLUME_SOURCE_TYPE,
  EXCHANGE_VOLUME_SOURCE,
  EXCHANGE_VOLUME_WINDOWS,
  emptyVolumeMetrics,
  expectedVolumeTradingDate,
} = require('../utils/exchangeVolume.cjs');
const { unavailableExUsVolume } = require('../utils/exUsVolume.cjs');

function unavailableUsVolume(targetDate, now, errorCode) {
  return {
    asOf: null,
    totalMarket: [],
    totalExchange: [],
    metrics: { exchange: emptyVolumeMetrics() },
    meta: {
      status: 'unavailable', verified: false, provider: 'Cboe',
      sourceType: EXCHANGE_VOLUME_SOURCE_TYPE, methodologyVersion: EXCHANGE_VOLUME_METHODOLOGY,
      asOfTradingDate: null, expectedTradingDate: targetDate, fetchedAt: new Date(now).toISOString(),
      comparisonWindows: EXCHANGE_VOLUME_WINDOWS, sourceBreakdown: [EXCHANGE_VOLUME_SOURCE], errorCode,
    },
  };
}

function createRegionalVolumeService({ usService, exUsService, now = () => new Date() }) {
  async function fetchSnapshot(options = {}) {
    const results = await Promise.allSettled([
      Promise.resolve().then(() => usService.fetchSnapshot(options)),
      Promise.resolve().then(() => exUsService.fetchSnapshot(options)),
    ]);
    const observedAt = now();
    const targetDate = expectedVolumeTradingDate(observedAt);
    const [usResult, exUsResult] = results;
    const usPayload = usResult.status === 'fulfilled' && usResult.value && typeof usResult.value === 'object'
      ? usResult.value
      : unavailableUsVolume(targetDate, observedAt, 'CBOE_VOLUME_FETCH_FAILED');
    const exUsPayload = exUsResult.status === 'fulfilled' && exUsResult.value && typeof exUsResult.value === 'object'
      ? exUsResult.value
      : unavailableExUsVolume(targetDate, observedAt, 'EX_US_VOLUME_FETCH_FAILED');
    return { ...usPayload, exUs: exUsPayload };
  }
  return { fetchSnapshot };
}

module.exports = { createRegionalVolumeService };
