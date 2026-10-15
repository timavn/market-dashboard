const {
  cpiSignalDetailsFromForecast,
  selectCpiForecast,
} = require('../predictionMarketsIngest/cpiNowcastSelector.cjs');
const {
  CONTRACT_REGISTRY,
} = require('./registry.cjs');

const QUOTE_STALE_MS = 10_000;
const BLS_RELEASE_WINDOW_MS = 15 * 60 * 1000;

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoTimestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function sourceFailure(error, fallbackCode) {
  return {
    code: error?.code || fallbackCode,
    message: String(error?.message || error || 'Source unavailable').slice(0, 300),
  };
}

function currentDateInTimeZone(now, timeZone) {
  const values = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now).forEach((part) => {
    if (part.type !== 'literal') values[part.type] = part.value;
  });
  return `${values.year}-${values.month}-${values.day}`;
}

function forecastTapeDate(product, now) {
  const today = currentDateInTimeZone(now, 'America/Chicago');
  const closeDate = currentDateInTimeZone(new Date(product.closeAt), 'America/Chicago');
  return (today < closeDate ? today : closeDate).replaceAll('-', '');
}

function resolverHealthSchedule(nowDate) {
  const cpi = CONTRACT_REGISTRY.find((product) => product.id === 'cpi');
  const releaseMs = Date.parse(String(cpi?.releaseAt || ''));
  const releaseAt = Number.isFinite(releaseMs) ? new Date(releaseMs).toISOString() : null;
  const windowOpensAt = Number.isFinite(releaseMs)
    ? new Date(releaseMs - BLS_RELEASE_WINDOW_MS).toISOString()
    : null;
  return {
    blsCpi: {
      releaseAt,
      reportMonth: cpi?.bls?.reportMonth || null,
      windowOpensAt,
      due: Number.isFinite(releaseMs) && nowDate.getTime() >= releaseMs - BLS_RELEASE_WINDOW_MS,
      released: Number.isFinite(releaseMs) && nowDate.getTime() >= releaseMs,
    },
  };
}

function createFailClosedCache({ ttlMs, nowMs }) {
  let value = null;
  let expiresAt = 0;
  let inFlight = null;
  let health = { status: 'not_started', lastSuccessAt: null, error: null };
  return {
    async load(loader) {
      if (value !== null && nowMs() < expiresAt) return value;
      if (inFlight) return inFlight;
      inFlight = Promise.resolve().then(loader).then((next) => {
        value = next;
        expiresAt = nowMs() + ttlMs;
        health = { status: 'available', lastSuccessAt: new Date(nowMs()).toISOString(), error: null };
        return next;
      }).catch((error) => {
        value = null;
        expiresAt = 0;
        health = { status: 'unavailable', lastSuccessAt: health.lastSuccessAt, error: sourceFailure(error, 'SOURCE_UNAVAILABLE') };
        throw error;
      }).finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    health() {
      return health;
    },
  };
}

function markFromIbkr(product, feedSnapshot, nowDate) {
  const provider = feedSnapshot?.provider || {};
  const state = product.feed ? feedSnapshot?.symbols?.[product.feed.symbol] : null;
  const baseUnavailable = {
    role: product.feed?.role || 'resolver',
    dataset: product.feed?.dataset || null,
    symbol: product.feed?.displaySymbol || product.feed?.symbol || null,
    rawSymbol: product.feed?.symbol || null,
    availability: provider.status === 'starting' ? 'starting' : 'unavailable',
    bid: null,
    ask: null,
    last: null,
    mark: null,
    markMethod: null,
    asOf: null,
    ageMs: null,
    warning: product.feed?.warning || null,
  };
  if (
    !product.feed
    || !state?.definition?.validation?.valid
    || !['live', 'degraded'].includes(provider.status)
    || state.status !== 'live'
  ) return baseUnavailable;

  const closeAt = Date.parse(product.closeAt);
  const marketClosed = Number.isFinite(closeAt) && nowDate.getTime() >= closeAt;
  if (marketClosed) {
    return {
      ...baseUnavailable,
      availability: 'market_closed',
      definition: state.definition,
      warning: [
        product.feed.warning,
        'The event is closed; a current post-event IBKR quote is not an official resolver settlement.',
      ].filter(Boolean).join(' '),
    };
  }
  const quoteAt = Date.parse(state.quote?.asOf || '');
  const tradeAt = Date.parse(state.trade?.asOf || '');
  const quoteAge = Number.isFinite(quoteAt) ? Math.max(0, nowDate.getTime() - quoteAt) : Number.POSITIVE_INFINITY;
  const tradeAge = Number.isFinite(tradeAt) ? Math.max(0, nowDate.getTime() - tradeAt) : Number.POSITIVE_INFINITY;
  const quoteUsable = state.quote && quoteAge <= QUOTE_STALE_MS;
  const tradeUsable = state.trade && tradeAge <= QUOTE_STALE_MS;
  let mark = null;
  let markMethod = null;
  let asOf = null;
  let ageMs = null;
  if (quoteUsable && finiteNumber(state.quote.bid) != null && finiteNumber(state.quote.ask) != null) {
    mark = (Number(state.quote.bid) + Number(state.quote.ask)) / 2;
    markMethod = 'calculated_bbo_midpoint';
    asOf = state.quote.asOf;
    ageMs = quoteAge;
  } else if (tradeUsable && finiteNumber(state.trade.price) != null) {
    mark = Number(state.trade.price);
    markMethod = 'last_trade';
    asOf = state.trade.asOf;
    ageMs = tradeAge;
  }
  const bestAge = Math.min(quoteAge, tradeAge);
  const availability = bestAge > QUOTE_STALE_MS
    ? 'stale'
    : product.feed.exact ? 'live_exact' : 'live_proxy';
  if (availability === 'stale') return { ...baseUnavailable, availability: 'stale', definition: state.definition };
  return {
    role: product.feed.role,
    dataset: product.feed.dataset,
    symbol: product.feed.displaySymbol,
    rawSymbol: product.feed.symbol,
    availability,
    bid: finiteNumber(state.quote?.bid),
    ask: finiteNumber(state.quote?.ask),
    bidSize: finiteNumber(state.quote?.bidSize),
    askSize: finiteNumber(state.quote?.askSize),
    last: finiteNumber(state.trade?.price),
    lastSize: finiteNumber(state.trade?.size),
    mark,
    markMethod,
    asOf,
    ageMs: Number.isFinite(ageMs) ? ageMs : null,
    definition: state.definition,
    marketStatus: state.marketStatus,
    warning: product.feed.warning || null,
  };
}

function markFromCoinbase(product, result, nowDate) {
  const base = {
    role: 'proxy',
    dataset: 'Coinbase Exchange public ticker',
    symbol: product.proxyFeed?.displaySymbol || product.proxyFeed?.symbol || null,
    rawSymbol: product.proxyFeed?.symbol || null,
    availability: result?.error ? 'unavailable' : 'starting',
    bid: null,
    ask: null,
    last: null,
    mark: null,
    markMethod: null,
    asOf: null,
    ageMs: null,
    warning: product.proxyFeed?.warning || null,
  };
  const ticker = result?.value;
  if (!ticker) return { ...base, error: result?.error || null };
  const sourceAt = Date.parse(ticker.sourceTimestamp || '');
  const ageMs = Number.isFinite(sourceAt) ? Math.max(0, nowDate.getTime() - sourceAt) : Number.POSITIVE_INFINITY;
  const marketClosed = nowDate.getTime() >= Date.parse(product.closeAt);
  if (marketClosed) {
    return {
      ...base,
      availability: 'market_closed',
      warning: [
        product.proxyFeed?.warning,
        'The event is closed; a current post-event Coinbase price is not a resolver value.',
      ].filter(Boolean).join(' '),
    };
  }
  const usable = ageMs <= QUOTE_STALE_MS;
  const bid = finiteNumber(ticker.bid);
  const ask = finiteNumber(ticker.ask);
  const last = finiteNumber(ticker.price);
  const mark = usable && bid != null && ask != null ? (bid + ask) / 2 : usable ? last : null;
  const availability = ageMs > QUOTE_STALE_MS ? 'stale' : 'live_proxy';
  if (availability === 'stale') return { ...base, availability: 'stale' };
  return {
    ...base,
    availability,
    bid,
    ask,
    last,
    mark,
    markMethod: mark == null ? null : bid != null && ask != null ? 'calculated_bbo_midpoint' : 'last_trade',
    asOf: ticker.sourceTimestamp,
    ageMs: Number.isFinite(ageMs) ? ageMs : null,
  };
}

function settlementFromKalshi(product, snapshot) {
  const hasFinalOutcome = Array.isArray(snapshot?.lines)
    && snapshot.lines.some((line) => ['yes', 'no'].includes(String(line?.result || '').toLowerCase()));
  if (!hasFinalOutcome || snapshot?.settlementValue == null || snapshot?.settlementConflict) return null;
  return {
    role: 'resolver',
    availability: 'official_final',
    value: snapshot.settlementValue,
    tradingDate: product.resolutionDate,
    final: true,
    asOf: snapshot.fetchedAt,
    source: 'kalshi_published_expiration_value',
    symbol: product.resolver.contractSymbol,
  };
}

function normalizeForecastLines(contractSnapshot, tapeSnapshot, venueConfig, nowDate) {
  const tradeByContract = new Map((tapeSnapshot?.trades || []).map((trade) => [trade.contractId, trade]));
  return (contractSnapshot?.lines || [])
    .filter((line) => line.contractId.startsWith(venueConfig.contractPrefix))
    .map((line) => {
      const trade = tradeByContract.get(line.contractId) || null;
      const closed = nowDate.getTime() >= Date.parse(venueConfig.closeAt);
      return {
        venue: 'ForecastEx',
        ticker: line.contractId,
        strike: line.strike,
        comparator: '>',
        status: closed ? 'closed' : 'open',
        availability: trade ? (closed ? 'market_closed' : 'live_exact') : 'unavailable',
        yesBid: null,
        yesAsk: null,
        noBid: null,
        noAsk: null,
        lastYes: finiteNumber(trade?.yesPrice),
        lastNo: finiteNumber(trade?.noPrice),
        lastQuantity: finiteNumber(trade?.quantity),
        priceType: 'last_trade',
        sourceTimestamp: trade?.pairTime || null,
        fetchedAt: tapeSnapshot?.fetchedAt || contractSnapshot?.fetchedAt || null,
        openInterest: line.openInterest,
        closeAt: venueConfig.closeAt,
        rulesUrl: line.rulesUrl,
      };
    });
}

function normalizeKalshiLines(snapshot, venueConfig, nowDate) {
  const closed = nowDate.getTime() >= Date.parse(venueConfig.closeAt);
  return (snapshot?.lines || []).map((line) => {
    const hasBook = [line.yesBid, line.yesAsk, line.noBid, line.noAsk].some((value) => finiteNumber(value) != null);
    return {
      ...line,
      status: closed ? 'closed' : line.status,
      availability: closed ? 'market_closed' : hasBook ? 'live_exact' : 'unavailable',
      closeAt: venueConfig.closeAt,
    };
  });
}

function probabilityReference(line) {
  if (line.venue === 'Kalshi' && finiteNumber(line.yesBid) != null && finiteNumber(line.yesAsk) != null) {
    return { value: (Number(line.yesBid) + Number(line.yesAsk)) / 2, method: 'calculated_yes_bbo_midpoint' };
  }
  if (line.venue === 'ForecastEx' && finiteNumber(line.lastYes) != null) {
    return { value: Number(line.lastYes), method: 'last_yes_trade' };
  }
  return { value: null, method: null };
}

function selectSummaryLine(lines, { referenceValue = null, cpi = false, range = false } = {}) {
  const candidates = lines.map((line) => {
    const probability = probabilityReference(line);
    let rangeDistance = null;
    if (range && referenceValue != null) {
      const lower = finiteNumber(line.lowerBound);
      const upper = finiteNumber(line.upperBound);
      const contains = line.strikeType === 'between'
        ? referenceValue >= lower && referenceValue <= upper
        : line.strikeType === 'less'
          ? referenceValue < upper
          : referenceValue >= lower;
      const boundaryDistances = [
        lower == null ? null : Math.abs(referenceValue - lower),
        upper == null ? null : Math.abs(upper - referenceValue),
      ].filter((value) => value != null);
      const points = boundaryDistances.length ? Math.min(...boundaryDistances) : null;
      rangeDistance = {
        kind: 'range',
        contains,
        points,
        percent: points == null || referenceValue === 0 ? null : (points / referenceValue) * 100,
        method: contains ? 'distance_to_nearest_range_edge' : 'distance_to_range',
      };
    }
    const score = cpi
      ? probability.value == null ? Number.POSITIVE_INFINITY : Math.abs(probability.value - 0.5)
      : range
        ? rangeDistance?.contains ? 0 : rangeDistance?.points ?? Number.POSITIVE_INFINITY
      : referenceValue == null ? Number.POSITIVE_INFINITY : Math.abs(line.strike - referenceValue);
    return { line, probability, rangeDistance, score };
  }).filter((candidate) => Number.isFinite(candidate.score));
  candidates.sort((left, right) => (
    left.score - right.score
    || Number(right.line.openInterest || 0) - Number(left.line.openInterest || 0)
    || left.line.strike - right.line.strike
  ));
  if (!candidates.length) return null;
  const selected = candidates[0];
  const distance = selected.rangeDistance || (!cpi && referenceValue != null
    ? {
      points: referenceValue - selected.line.strike,
      percent: selected.line.strike === 0 ? null : ((referenceValue / selected.line.strike) - 1) * 100,
      method: 'reference_minus_strike',
    }
    : null);
  return {
    ...selected.line,
    selectionMethod: cpi
      ? 'closest_yes_price_to_50c'
      : selected.rangeDistance ? 'range_containing_or_nearest_reference' : 'closest_strike_to_reference',
    probabilityReference: selected.probability,
    distance,
  };
}

function riskRangeObservation(product, envelope) {
  if (!product.hedgeye?.ticker) return null;
  const range = envelope?.ranges?.[product.hedgeye.ticker];
  const verifiedCurrent = envelope?.available === true
    && envelope?.status === 'current'
    && envelope?.manifest?.publicationDate
    && envelope.manifest.publicationDate === envelope.manifest.expectedDate;
  return {
    role: 'research',
    label: product.hedgeye.label,
    ticker: product.hedgeye.ticker,
    fit: product.hedgeye.fit,
    publicationStatus: verifiedCurrent && range ? 'current' : envelope?.status === 'stale' ? 'stale' : 'unavailable',
    lrr: verifiedCurrent ? finiteNumber(range?.lrr) : null,
    hrr: verifiedCurrent ? finiteNumber(range?.hrr) : null,
    trend: verifiedCurrent ? range?.trend || null : null,
    sourceDate: verifiedCurrent ? range?.date || envelope.manifest.publicationDate : envelope?.manifest?.publicationDate || null,
    asOf: verifiedCurrent ? isoTimestamp(range?.timestamp || envelope.manifest.latestUpdatedAt) : null,
    source: verifiedCurrent ? range?.source || 'hedgeye_risk_ranges' : null,
    warning: product.hedgeye.warning,
  };
}

function cpiNowcastObservation(product, snapshots, nowDate) {
  const forecast = selectCpiForecast(snapshots || [], {
    now: nowDate,
    requiredMonth: product.hedgeye.requiredMonth,
    current: false,
  });
  if (!forecast) {
    return {
      role: 'research',
      label: product.hedgeye.label,
      fit: product.hedgeye.fit,
      publicationStatus: 'unavailable',
      scenarios: [],
      sourceDate: null,
      asOf: null,
      warning: product.hedgeye.warning,
    };
  }
  const details = cpiSignalDetailsFromForecast(forecast);
  return {
    role: 'research',
    label: product.hedgeye.label,
    fit: product.hedgeye.fit,
    publicationStatus: 'current',
    forecastMonth: details.forecastMonth,
    metric: details.metric,
    releaseAt: details.releaseAt,
    scenarios: details.scenarios,
    sourceDate: forecast.snapshot?.date || null,
    asOf: isoTimestamp(forecast.publishedAt || forecast.snapshot?.publishedAt || forecast.snapshot?.scrapedAt),
    source: forecast.source?.kind || forecast.snapshot?.sourceProduct || 'hedgeye_inflation_nowcast',
    warning: product.hedgeye.warning,
  };
}

function cryptoTrackerObservation(product, snapshots) {
  const rows = Array.isArray(snapshots) ? snapshots : snapshots ? [snapshots] : [];
  const snapshot = rows.find((row) => (
    row?.snapshotType === product.hedgeye.sourceType
    && row?.date === product.hedgeye.requiredDate
  ));
  const slot = snapshot?.data?.cryptos?.[product.hedgeye.ticker] || null;
  if (!snapshot || !slot) {
    return {
      role: 'research',
      label: product.hedgeye.label,
      ticker: product.hedgeye.ticker,
      fit: product.hedgeye.fit,
      publicationStatus: 'unavailable',
      levels: null,
      sourceDate: snapshot?.date || null,
      asOf: null,
      warning: product.hedgeye.warning,
    };
  }
  return {
    role: 'research',
    label: product.hedgeye.label,
    ticker: product.hedgeye.ticker,
    fit: product.hedgeye.fit,
    publicationStatus: 'current',
    levels: {
      price: finiteNumber(slot.price),
      buyTrade: finiteNumber(slot.buyTrade),
      sellTrade: finiteNumber(slot.sellTrade),
      trend: slot.trend || null,
    },
    sourceDate: snapshot.date,
    asOf: isoTimestamp(snapshot.scrapedAt || snapshot.publishedAt),
    source: 'hedgeye_bitcoin_trend_tracker',
    warning: product.hedgeye.warning,
  };
}

function publicResult(result, fallbackCode) {
  return result.status === 'fulfilled'
    ? { value: result.value, error: null }
    : { value: null, error: sourceFailure(result.reason, fallbackCode) };
}

function exactFeedProvidersAreLive(providers) {
  const exactIbkrProducts = CONTRACT_REGISTRY.filter((product) => (
    product.feed?.provider === 'ibkr' && product.feed?.exact === true
  ));
  const health = providers?.ibkrFutures;
  return ['live', 'degraded'].includes(health?.status) && exactIbkrProducts.every((product) => (
    health.symbols?.[product.feed.symbol]?.status === 'live'
  ));
}

function createPredictionMarketTestService({
  feed,
  publicSources,
  loadRiskRanges = async () => null,
  loadInflationNowcasts = async () => [],
  loadCryptoTracker = async () => [],
  now = () => new Date(),
} = {}) {
  if (!feed || !publicSources) throw new TypeError('feed and publicSources are required');
  const riskCache = createFailClosedCache({ ttlMs: 60_000, nowMs: () => now().getTime() });
  const nowcastCache = createFailClosedCache({ ttlMs: 60_000, nowMs: () => now().getTime() });
  const cryptoTrackerCache = createFailClosedCache({ ttlMs: 60_000, nowMs: () => now().getTime() });
  let lastSnapshotAt = null;

  async function getSnapshot() {
    const requestDate = now();
    const forecastProducts = CONTRACT_REGISTRY.filter((product) => product.venues.some((venue) => venue.venue === 'ForecastEx'));
    const kalshiVenues = CONTRACT_REGISTRY.flatMap((product) => product.venues
      .filter((venue) => venue.venue === 'Kalshi')
      .map((venue) => ({ product, venue })));
    const tapeGroups = new Map();
    forecastProducts.forEach((product) => {
      const date = forecastTapeDate(product, requestDate);
      const prefixes = tapeGroups.get(date) || new Set();
      product.venues.filter((venue) => venue.venue === 'ForecastEx').forEach((venue) => prefixes.add(venue.contractPrefix));
      tapeGroups.set(date, prefixes);
    });

    const kalshiRequest = Promise.allSettled(kalshiVenues.map(({ venue }) => publicSources.getKalshiEvent(venue.eventTicker)));
    const cryptoProducts = CONTRACT_REGISTRY.filter((product) => product.proxyFeed?.provider === 'coinbase_exchange');
    const coinbaseRequest = Promise.allSettled(cryptoProducts.map((product) => (
      publicSources.getCoinbaseSpot(product.proxyFeed.symbol)
    )));
    const contractsRequest = Promise.allSettled(forecastProducts.map((product) => {
      const venue = product.venues.find((entry) => entry.venue === 'ForecastEx');
      return publicSources.getForecastExContracts(venue.productCode);
    }));
    const tapeEntries = [...tapeGroups.entries()];
    const tapesRequest = Promise.allSettled(tapeEntries.map(([date, prefixes]) => (
      publicSources.getForecastExPairs(date, [...prefixes])
    )));
    const cpiProduct = CONTRACT_REGISTRY.find((product) => product.id === 'cpi');
    const auxiliaryRequest = Promise.allSettled([
      riskCache.load(() => loadRiskRanges({ now: requestDate })),
      nowcastCache.load(() => loadInflationNowcasts({ limit: 50 })),
      cryptoTrackerCache.load(() => loadCryptoTracker({ limit: 2 })),
      publicSources.getBlsCpi(cpiProduct),
    ]);
    const [kalshiSettled, coinbaseSettled, contractsSettled, tapesSettled, auxiliarySettled] = await Promise.all([
      kalshiRequest,
      coinbaseRequest,
      contractsRequest,
      tapesRequest,
      auxiliaryRequest,
    ]);
    const [riskSettled, nowcastSettled, cryptoTrackerSettled, blsSettled] = auxiliarySettled;
    // Stamp and validate the assembled snapshot at completion, not request
    // start. Slow upstreams must consume freshness budget before delivery.
    const nowDate = now();

    const kalshiByTicker = new Map(kalshiVenues.map(({ venue }, index) => [
      venue.eventTicker,
      publicResult(kalshiSettled[index], 'PM_TEST_KALSHI_UNAVAILABLE'),
    ]));
    const contractsByProduct = new Map(forecastProducts.map((product, index) => {
      const venue = product.venues.find((entry) => entry.venue === 'ForecastEx');
      return [venue.productCode, publicResult(contractsSettled[index], 'PM_TEST_FORECASTEX_CONTRACTS_UNAVAILABLE')];
    }));
    const coinbaseBySymbol = new Map(cryptoProducts.map((product, index) => [
      product.proxyFeed.symbol,
      publicResult(coinbaseSettled[index], 'PM_TEST_COINBASE_UNAVAILABLE'),
    ]));
    const tapesByDate = new Map(tapeEntries.map(([date], index) => [
      date,
      publicResult(tapesSettled[index], 'PM_TEST_FORECASTEX_TAPE_UNAVAILABLE'),
    ]));
    const feedSnapshot = feed.getSnapshot();
    const risk = publicResult(riskSettled, 'PM_TEST_HEDGEYE_RISK_RANGE_UNAVAILABLE');
    const nowcasts = publicResult(nowcastSettled, 'PM_TEST_HEDGEYE_NOWCAST_UNAVAILABLE');
    const cryptoTracker = publicResult(cryptoTrackerSettled, 'PM_TEST_HEDGEYE_CRYPTO_TRACKER_UNAVAILABLE');
    const bls = publicResult(blsSettled, 'PM_TEST_BLS_UNAVAILABLE');

    const products = CONTRACT_REGISTRY.map((product) => {
      const ibkrObservation = product.feed?.provider === 'ibkr'
        ? markFromIbkr(product, feedSnapshot, nowDate)
        : null;
      const exactFeedObservation = product.feed?.exact ? ibkrObservation : null;
      const coinbaseResult = product.proxyFeed ? coinbaseBySymbol.get(product.proxyFeed.symbol) : null;
      const proxyFeedObservation = product.proxyFeed
        ? markFromCoinbase(product, coinbaseResult, nowDate)
        : product.feed && !product.feed.exact ? ibkrObservation : null;
      let settlementObservation = null;
      const venueErrors = [];
      const lines = [];
      product.venues.forEach((venue) => {
        if (venue.venue === 'Kalshi') {
          const result = kalshiByTicker.get(venue.eventTicker);
          if (result?.error) venueErrors.push({ venue: 'Kalshi', ...result.error });
          lines.push(...normalizeKalshiLines(result?.value, venue, nowDate));
          if (['wti', 'bitcoin', 'ethereum'].includes(product.id)) {
            settlementObservation = settlementFromKalshi(product, result?.value) || settlementObservation;
          }
        } else if (venue.venue === 'ForecastEx') {
          const contractResult = contractsByProduct.get(venue.productCode);
          const tapeResult = tapesByDate.get(forecastTapeDate(product, nowDate));
          if (contractResult?.error) venueErrors.push({ venue: 'ForecastEx contracts', ...contractResult.error });
          if (tapeResult?.error) venueErrors.push({ venue: 'ForecastEx tape', ...tapeResult.error });
          lines.push(...normalizeForecastLines(contractResult?.value, tapeResult?.value, venue, nowDate));
        }
      });

      if (coinbaseResult?.error) venueErrors.push({ venue: 'Coinbase proxy', ...coinbaseResult.error });

      if (product.id === 'cpi' && bls.value) {
        settlementObservation = {
          role: 'resolver',
          ...bls.value,
          source: bls.value.method === 'literal_release_sentence' ? 'bls_release' : 'bls_api',
          symbol: product.bls.seriesId,
        };
      } else if (product.id === 'cpi' && bls.error) {
        settlementObservation = {
          role: 'resolver',
          availability: 'unavailable',
          value: null,
          asOf: null,
          source: 'bls',
          symbol: product.bls.seriesId,
          warning: bls.error.message,
        };
      }
      const referenceValue = finiteNumber(settlementObservation?.value) != null
        ? Number(settlementObservation.value)
        : finiteNumber(exactFeedObservation?.mark) != null
          ? Number(exactFeedObservation.mark)
          : finiteNumber(proxyFeedObservation?.mark);
      const summaryLine = selectSummaryLine(lines, {
        referenceValue,
        cpi: product.id === 'cpi',
        range: product.contractShape === 'range',
      });
      const markedLines = lines.map((line) => ({
        ...line,
        isNearest: Boolean(summaryLine && line.venue === summaryLine.venue && line.ticker === summaryLine.ticker),
      })).sort((left, right) => left.strike - right.strike || left.venue.localeCompare(right.venue));
      const hedgeyeObservation = product.hedgeye?.sourceType === 'bitcoin-trend-tracker'
        ? cryptoTrackerObservation(product, cryptoTracker.value)
        : product.id === 'cpi'
          ? cpiNowcastObservation(product, nowcasts.value, nowDate)
          : riskRangeObservation(product, risk.value);

      return {
        id: product.id,
        displayName: product.displayName,
        measuredPeriod: product.measuredPeriod,
        contractShape: product.contractShape,
        comparator: product.comparator,
        precision: product.precision,
        unit: product.unit,
        closeAt: product.closeAt,
        resolver: product.resolver,
        resolverObservation: product.feed?.exact ? exactFeedObservation : product.id === 'cpi' ? settlementObservation : null,
        proxyObservation: proxyFeedObservation,
        settlementObservation,
        hedgeyeObservation,
        summaryLine,
        lines: markedLines,
        lineCount: markedLines.length,
        venueErrors,
      };
    });

    lastSnapshotAt = nowDate.toISOString();
    const providers = {
      ibkrFutures: feed.getHealth(),
      ...publicSources.getHealth(),
      hedgeyeRiskRanges: riskCache.health(),
      hedgeyeInflationNowcast: nowcastCache.health(),
      hedgeyeCryptoTracker: cryptoTrackerCache.health(),
    };
    const degraded = !exactFeedProvidersAreLive(providers)
      || Object.values(providers).some((provider) => provider?.status === 'unavailable');
    return {
      schemaVersion: 1,
      generatedAt: lastSnapshotAt,
      status: degraded ? 'degraded' : 'live',
      providers,
      products,
    };
  }

  function getHealth() {
    const nowDate = now();
    const providers = {
      ibkrFutures: feed.getHealth(),
      ...publicSources.getHealth(),
      hedgeyeRiskRanges: riskCache.health(),
      hedgeyeInflationNowcast: nowcastCache.health(),
      hedgeyeCryptoTracker: cryptoTrackerCache.health(),
    };
    return {
      ok: true,
      generatedAt: nowDate.toISOString(),
      lastSnapshotAt,
      status: exactFeedProvidersAreLive(providers) ? 'live' : 'degraded',
      providers,
      schedule: resolverHealthSchedule(nowDate),
    };
  }

  return {
    getHealth,
    getSnapshot,
    // IBKR quotes are live marks, never official resolver settlements.
    getResolverSettlements: () => [],
    start: () => {
      feed.start();
    },
    stop: () => {
      feed.stop();
    },
  };
}

module.exports = {
  BLS_RELEASE_WINDOW_MS,
  QUOTE_STALE_MS,
  createPredictionMarketTestService,
  exactFeedProvidersAreLive,
  forecastTapeDate,
  cryptoTrackerObservation,
  markFromCoinbase,
  markFromIbkr,
  normalizeForecastLines,
  resolverHealthSchedule,
  selectSummaryLine,
  settlementFromKalshi,
};
