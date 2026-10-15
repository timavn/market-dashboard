const { dateForPoint, sessionWindowForDate } = require('./resolverChartSessions.cjs');

const KALSHI_PERPETUAL_API = 'https://external-api.kalshi.com/trade-api/v2/margin';
const DAY_MS = 24 * 60 * 60_000;
const QUOTE_MAX_AGE_MS = 60_000;
const FUTURE_TOLERANCE_MS = 5_000;
const RANGES = ['1d', '5d', '10d'];
const INVALID_PROVENANCE = /delayed|frozen|stale|cache|mock|fixture|seed|fallback|offline|disconnected|synthetic|inferred|derived|unavailable|error/i;
const CONTRACTS = Object.freeze({
  bitcoin: Object.freeze({ ticker: 'KXBTCPERP', name: 'Bitcoin', symbol: 'BTC', label: 'BTC', riskRangeTicker: 'BITCOIN', contractSize: 0.0001, priceUnit: 'USD/BTC' }),
  ethereum: Object.freeze({ ticker: 'KXETHPERP', name: 'Ethereum', symbol: 'ETH', label: 'ETH', riskRangeTicker: 'ETH', contractSize: 0.001, priceUnit: 'USD/ETH' }),
});

function number(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function verifiedMetadata(value) {
  if (!value || typeof value !== 'object') return false;
  if (['stale', 'isStale', 'fromCache', 'cached', 'cachedOnly', 'cacheOnly', 'seeded', 'mock', 'isMock', 'fixture', 'synthetic', 'refreshFailed', 'offline']
    .some((key) => value[key] === true)) return false;
  if (value.connected === false || value.isConnected === false || value.live === false) return false;
  if (INVALID_PROVENANCE.test([
    value.source, value.provider, value.provenance, value.warning, value.cacheState,
    value.status, value.availability, value.connectionStatus,
  ].filter((item) => typeof item === 'string').join(' '))) return false;
  return ['metadata', 'freshness'].every((key) => value[key] == null || verifiedMetadata(value[key]));
}

function payloadFrom(result) {
  if (result.status !== 'fulfilled' || !verifiedMetadata(result.value)) return null;
  const response = result.value;
  if (typeof response.status === 'number' && (response.status < 200 || response.status >= 300)) return null;
  const payload = response.data;
  return verifiedMetadata(payload) ? payload : null;
}

function unavailableSection(reason, extras = {}) {
  return { status: 'unavailable', availability: 'unavailable', source: null, asOf: null,
    expiresAt: null, value: null, fit: 'exact', referenceKind: 'perpetual_contract',
    executable: false, refreshFailed: true, reason, ...extras };
}

function unavailableVariant(range, reason) {
  return unavailableSection(reason, { range, points: [], references: [], dailyRanges: [],
    rangeDates: [], latestAt: null, latestValue: null });
}

function emptyChart(reason) {
  const variants = Object.fromEntries(RANGES.map((range) => [range, unavailableVariant(range, reason)]));
  return { ...variants['1d'], variants };
}

function referenceResult(definition, spot, chart) {
  const instrument = {
    symbol: definition.ticker, ticker: definition.ticker, displaySymbol: definition.label, underlyingSymbol: definition.symbol,
    secType: 'FUT', exchange: 'KALSHI', currency: 'USD', provider: 'kalshi',
    contractSize: definition.contractSize, perpetual: true, priceUnit: definition.priceUnit,
  };
  const resolver = `Kalshi ${definition.ticker}`;
  return {
    spot, chart, fit: 'exact', referenceKind: 'perpetual_contract', instrument, resolver,
    proxyFit: null, backgroundRefresh: false,
    secondaryContextRefreshPending: RANGES.some((range) => chart.variants?.[range]?.riskRangeRefreshPending === true),
    chartReferences: {
      basis: {
        role: 'basis', symbol: definition.label, riskRangeTicker: definition.riskRangeTicker,
        exact: true, fit: 'exact', referenceKind: 'perpetual_contract', instrument, resolver,
        spot, chart, disclosure: null,
        freshness: {
          status: spot.status === 'available' ? 'verified_live' : 'unavailable',
          asOf: spot.asOf, expiresAt: spot.expiresAt, reason: spot.reason || null,
        },
      },
    },
  };
}

function withPerpetualChartReference(reference, marketId = 'bitcoin') {
  const definition = CONTRACTS[marketId];
  if (!definition) return reference;
  const reason = `Verified Kalshi ${definition.name} perpetual data is unavailable.`;
  const isOtherSource = (section) => (section?.source || section?.value != null || section?.points?.length)
    && !String(section?.source || '').startsWith('kalshi_perpetual_');
  const safeSpot = isOtherSource(reference?.spot)
    ? unavailableSection(reason) : reference?.spot || unavailableSection(reason);
  const spot = { ...safeSpot, label: definition.label, fit: 'exact', referenceKind: 'perpetual_contract' };
  const stripOtherHistory = (section, range) => {
    if (!section || isOtherSource(section)) return unavailableVariant(range, reason);
    const { ath: _ath, ...safe } = section;
    return { ...safe, fit: 'exact', referenceKind: 'perpetual_contract', ticker: definition.ticker,
      label: definition.label, references: (safe.references || []).filter((row) => row.kind !== 'ath' && row.label !== 'ATH') };
  };
  const variants = Object.fromEntries(RANGES.map((range) => [range,
    stripOtherHistory(reference?.chart?.variants?.[range] || (range === '1d' ? reference?.chart : null), range),
  ]));
  const chart = { ...variants['1d'], variants };
  return { ...reference, ...referenceResult(definition, spot, chart),
    backgroundRefresh: reference?.backgroundRefresh === true };
}

function candlePoints(payload, definition, nowMs, oldestMs, maxAgeMs) {
  if (!payload || payload.ticker !== definition.ticker || !Array.isArray(payload.candlesticks)) return [];
  const pointsByTime = new Map();
  for (const candle of payload.candlesticks) {
    if (!verifiedMetadata(candle) || !verifiedMetadata(candle.price)) continue;
    const endSeconds = number(candle.end_period_ts);
    const timestamp = endSeconds == null ? NaN : endSeconds * 1000;
    const close = number(candle.price.close);
    // A previous close, mark or bid/ask midpoint is never a trade candle.
    if (close == null || close <= 0 || !(number(candle.volume) > 0) || !Number.isFinite(timestamp)
      || timestamp < oldestMs || timestamp > nowMs) continue;
    pointsByTime.set(timestamp, {
      timestamp, value: close / definition.contractSize,
      source: 'kalshi_perpetual_public_candles', ticker: definition.ticker,
    });
  }
  const points = [...pointsByTime.values()].sort((left, right) => left.timestamp - right.timestamp);
  const latest = points.at(-1);
  return latest && nowMs - latest.timestamp <= maxAgeMs ? points : [];
}

async function loadKalshiPerpetualReference({
  marketId, client, nowMs, loadRiskRangeHistory, buildChartVariants,
  buildResolverChartSession, previousCalendarSessionDate,
}) {
  const definition = CONTRACTS[marketId];
  if (!definition) throw new Error('Unsupported Kalshi perpetual reference market.');
  const reason = `Verified Kalshi ${definition.name} perpetual data is unavailable.`;
  const options = { timeout: 8_000 };
  const end = Math.floor(nowMs / 1000);
  const candleRequest = (days, interval) => client.get(
    `${KALSHI_PERPETUAL_API}/markets/${definition.ticker}/candlesticks`,
    { ...options, params: { start_ts: Math.floor((nowMs - days * DAY_MS) / 1000), end_ts: end, period_interval: interval } },
  );
  const results = await Promise.allSettled([
    client.get(`${KALSHI_PERPETUAL_API}/markets/${definition.ticker}`, options),
    client.get(`${KALSHI_PERPETUAL_API}/trades`, { ...options, params: { ticker: definition.ticker, limit: 10 } }),
    candleRequest(2, 1),
    candleRequest(12, 60),
  ]);
  const [marketPayload, tradesPayload, oneDayPayload, multiDayPayload] = results.map(payloadFrom);
  const market = marketPayload?.market;
  if (!verifiedMetadata(market) || market.ticker !== definition.ticker || market.status !== 'active'
    || number(market.contract_size) !== definition.contractSize
    || number(market.underlying_multiplier) !== 1 || market.schedule?.is_open === false) {
    return referenceResult(definition, unavailableSection(reason, { label: definition.label }), emptyChart(reason));
  }

  const trades = (Array.isArray(tradesPayload?.trades) ? tradesPayload.trades : [])
    .filter((trade) => verifiedMetadata(trade) && trade.ticker === definition.ticker)
    .map((trade) => ({ timestamp: Date.parse(trade.created_time || ''), price: number(trade.price) }))
    .filter((trade) => trade.price != null && trade.price > 0 && Number.isFinite(trade.timestamp)
      && nowMs - trade.timestamp >= -FUTURE_TOLERANCE_MS && nowMs - trade.timestamp <= QUOTE_MAX_AGE_MS)
    .sort((left, right) => right.timestamp - left.timestamp);
  const latest = trades[0];
  let spot = latest ? {
    status: 'available', availability: 'live', value: latest.price / definition.contractSize,
    label: definition.label, source: 'kalshi_perpetual_public_trades', ticker: definition.ticker,
    asOf: new Date(latest.timestamp).toISOString(), expiresAt: new Date(latest.timestamp + QUOTE_MAX_AGE_MS).toISOString(),
    fit: 'exact', referenceKind: 'perpetual_contract', executable: false, reason: null,
  } : unavailableSection(reason, { label: definition.label });
  const currentPoint = latest ? {
    timestamp: latest.timestamp, value: spot.value, source: spot.source,
    ticker: definition.ticker, verifiedCurrent: true,
  } : null;
  const oneDayPoints = candlePoints(oneDayPayload, definition, nowMs, nowMs - 2 * DAY_MS, 10 * 60_000);
  const multiDayPoints = candlePoints(multiDayPayload, definition, nowMs, nowMs - 12 * DAY_MS, 75 * 60_000);
  // Perpetuals have a continuous session, independent of the selected binary event.
  const chartSession = buildResolverChartSession({ marketId, nowMs });
  let chart = await buildChartVariants({
    oneDayPoints, multiDayPoints, currentPoint,
    config: {
      label: `Kalshi ${definition.name} perpetual`, latestCompletedDate: previousCalendarSessionDate,
      riskRangeTicker: definition.riskRangeTicker, carryRiskRangeAcrossNonPublicationSessions: true,
      chartSession, allowCoarserOneDay: false,
    },
    nowMs, source: 'kalshi_perpetual_public_candles', oneDayInterval: '1m', multiDayInterval: '1h',
    fit: 'exact', label: definition.label, calendarSessions: true, loadRiskRangeHistory, riskRangeWaitMs: 150,
  });
  const variants = Object.fromEntries(RANGES.map((range) => {
    const hasFreshHistory = range === '1d' ? oneDayPoints.length > 0 : multiDayPoints.length > 0;
    return [range, hasFreshHistory
      ? { ...chart.variants[range], referenceKind: 'perpetual_contract', ticker: definition.ticker }
      : unavailableVariant(range, reason)];
  }));
  chart = { ...variants['1d'], variants };
  // Kalshi timestamps candles at the end of their interval. The midnight
  // candle therefore closes the previous calendar session; selecting the last
  // timestamp dated yesterday would incorrectly use the 23:00 candle.
  const currentSessionDate = dateForPoint(chartSession, nowMs);
  const currentWindow = sessionWindowForDate(chartSession?.profile, currentSessionDate, { nowMs });
  const sessionStartMs = Date.parse(currentWindow?.startAt || '');
  const priorClose = Number.isFinite(sessionStartMs)
    ? multiDayPoints.find((point) => point.timestamp === sessionStartMs)
    : null;
  if (priorClose) {
    const previous = { previousClose: priorClose.value, previousCloseAsOf: new Date(priorClose.timestamp).toISOString(),
      previousCloseSource: 'kalshi_perpetual_public_candles' };
    if (spot.status === 'available') spot = { ...spot, ...previous };
    const nextVariants = Object.fromEntries(RANGES.map((range) => [range,
      chart.variants[range].status === 'available' ? { ...chart.variants[range], ...previous } : chart.variants[range],
    ]));
    chart = { ...nextVariants['1d'], variants: nextVariants };
  }
  return referenceResult(definition, spot, chart);
}

module.exports = { loadKalshiPerpetualReference, withPerpetualChartReference, PERPETUAL_MARKETS: CONTRACTS };
