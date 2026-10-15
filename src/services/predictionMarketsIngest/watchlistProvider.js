const { kalshiFetch } = require('./providers/kalshiClient');
const {
  checkGatewayHealth,
  fetchCurrentIbkrPredictionSnapshot,
} = require('./providers/ibkrProvider');
const { classifyQuoteAvailability } = require('../providers/multiRegionQuoteIntegrity.cjs');
const {
  isTradingDateKey,
  previousTradingDateKey,
} = require('../volatilitySnapshotService.cjs');
const {
  cpiMonthFromEvent,
  loadClevelandFedCpiNowcast,
} = require('./signalAvailabilityProvider');

const DAY_MS = 24 * 60 * 60 * 1000;
const NEW_YORK_SESSION_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const NEW_YORK_TIMESTAMP_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
const IBKR_QUOTE_MAX_AGE_MS = Number(process.env.PM_IBKR_QUOTE_MAX_AGE_MS || 60000);
const SPX_CLOSE_SERIES_TICKER = 'KXINXU';
const SPX_CLOSE_EVENT_SUFFIX = 'H1600';
const SPX_RECENT_SETTLED_DEFAULT_LIMIT = 13;
const SPX_RECENT_SETTLED_MAX_LIMIT = 15;
const SPX_SETTLED_EVENT_PATTERN = new RegExp(`^${SPX_CLOSE_SERIES_TICKER}-\\d{2}[A-Z]{3}\\d{2}${SPX_CLOSE_EVENT_SUFFIX}$`);
const WTI_RECENT_SETTLED_DEFAULT_LIMIT = 13;
const WTI_RECENT_SETTLED_MAX_LIMIT = 15;
const WTI_SETTLED_DETAIL_SCAN_MAX = 50;
const WTI_SETTLEMENT_CLOSE_MINUTES = 14 * 60 + 30;
const OVERVIEW_CHART_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const OVERVIEW_UNDERLYING_CHART_INTERVAL = '5m';
const OVERVIEW_UNDERLYING_HISTORY_RETRY_DELAY_MS = 150;
const SPX_UNDERLYING_HISTORY_MAX_ATTEMPTS = 3;
const MULTI_DAY_HISTORY_RANGE = '10d';
const MULTI_DAY_SESSION_COUNT = 5;
const FORBIDDEN_UNDERLYING_HISTORY_PROVENANCE = /delayed|frozen|stale|cache(?:d|_only|-only)?|mock|seed|fallback|offline|disconnected|synthetic|inferred|derived/i;
const WTI_CADENCE_CONFIG = Object.freeze({
  daily: Object.freeze({
    cadence: 'daily',
    seriesTicker: 'KXWTI',
    mutuallyExclusive: false,
    horizonDays: 15,
    historyLookbackDays: 60,
    label: 'WTI daily settlement',
  }),
  weekly: Object.freeze({
    cadence: 'weekly',
    seriesTicker: 'KXWTIW',
    mutuallyExclusive: true,
    horizonDays: 21,
    historyLookbackDays: 180,
    label: 'WTI weekly settlement',
  }),
});

const WATCHLIST_SERIES = [
  {
    seriesTicker: 'KXCPIYOY',
    label: 'Headline CPI YoY',
    assetClass: 'Inflation',
    hedgeyeSignal: 'Hedgeye Inflation Nowcast',
    matchType: 'exact',
    matchLabel: 'Exact signal',
    matchReason: 'Same BLS headline CPI year-over-year release used by the CPI workflow.',
    cadence: 'Monthly',
    occurrencesPerMonth: 1,
    horizonDays: 370,
    researchPriority: 0,
    screeningLabel: 'Native forecast match',
  },
  {
    seriesTicker: 'KXINXU',
    label: 'S&P 500 daily threshold',
    assetClass: 'Equities',
    hedgeyeSignal: 'SPX Risk Range',
    matchType: 'calibration',
    matchLabel: 'Best daily RR fit',
    matchReason: 'Settles on the 4 p.m. cash S&P 500 close. The underlying matches SPX Risk Range, but an intraday range still must be calibrated into a closing-threshold probability.',
    cadence: 'Trading-day 4 p.m. close',
    occurrencesPerMonth: 22,
    horizonDays: 4,
    eventTickerSuffix: 'H1600',
    researchPriority: 1,
    screeningLabel: 'Primary daily study',
  },
  {
    seriesTicker: 'KXINX',
    label: 'S&P 500 close bucket',
    assetClass: 'Equities',
    hedgeyeSignal: 'SPX Risk Range',
    matchType: 'calibration',
    matchLabel: 'Needs calibration',
    matchReason: 'The cash-index underlying matches, but one Risk Range spans several mutually exclusive close buckets and does not identify the closing bucket by itself.',
    cadence: 'Trading-day 4 p.m. close',
    occurrencesPerMonth: 22,
    horizonDays: 4,
    researchPriority: 2,
    screeningLabel: 'Secondary daily study',
  },
  {
    seriesTicker: 'KXWTI',
    label: 'WTI daily price',
    assetClass: 'Commodities',
    hedgeyeSignal: 'WTI Risk Range',
    matchType: 'calibration',
    matchLabel: 'Needs calibration',
    matchReason: 'The contract uses a specified WTI futures settlement. Confirm the Hedgeye proxy, contract month, and roll convention before calibrating the intraday range to settlement.',
    cadence: 'Trading days',
    occurrencesPerMonth: 22,
    horizonDays: 4,
    researchPriority: 3,
    screeningLabel: 'Requires roll check',
  },
  {
    seriesTicker: 'KXWTIW',
    label: 'WTI weekly price',
    assetClass: 'Commodities',
    hedgeyeSignal: 'WTI Risk Range',
    matchType: 'calibration',
    matchLabel: 'Needs calibration',
    matchReason: 'Despite the weekly label, it resolves on Friday\'s single WTI settlement. Use Friday\'s fresh range only after the exact futures month and roll convention are verified.',
    cadence: 'Weekly',
    occurrencesPerMonth: 4,
    horizonDays: 15,
    researchPriority: 4,
    screeningLabel: 'Friday-only study',
  },
  {
    seriesTicker: 'KXFEDDECISION',
    label: 'Fed meeting decision',
    assetClass: 'Rates',
    hedgeyeSignal: 'No exact Hedgeye input wired',
    matchType: 'missing_signal',
    matchLabel: 'Missing signal',
    matchReason: 'Liquid macro contract, but the dashboard has no exact Fed-decision forecast signal yet.',
    cadence: 'FOMC meetings',
    occurrencesPerMonth: 0.7,
    horizonDays: 400,
    researchPriority: 20,
  },
  {
    seriesTicker: 'KXFED',
    label: 'Fed funds target',
    assetClass: 'Rates',
    hedgeyeSignal: 'No exact Hedgeye input wired',
    matchType: 'missing_signal',
    matchLabel: 'Missing signal',
    matchReason: 'Rate-level contract requires a meeting-path probability model, not a generic rates risk range.',
    cadence: 'FOMC meetings',
    occurrencesPerMonth: 0.7,
    horizonDays: 400,
    researchPriority: 21,
  },
  {
    seriesTicker: 'KXPAYROLLS',
    label: 'Nonfarm payrolls',
    assetClass: 'Labor',
    hedgeyeSignal: 'No exact Hedgeye input wired',
    matchType: 'missing_signal',
    matchLabel: 'Missing signal',
    matchReason: 'Monthly release has repeatable timing, but needs an exact payroll forecast range.',
    cadence: 'Monthly',
    occurrencesPerMonth: 1,
    horizonDays: 370,
    researchPriority: 22,
  },
  {
    seriesTicker: 'KXU3',
    label: 'Unemployment rate',
    assetClass: 'Labor',
    hedgeyeSignal: 'No exact Hedgeye input wired',
    matchType: 'missing_signal',
    matchLabel: 'Missing signal',
    matchReason: 'Monthly release has repeatable timing, but needs an exact U-3 forecast range.',
    cadence: 'Monthly',
    occurrencesPerMonth: 1,
    horizonDays: 370,
    researchPriority: 23,
  },
  {
    seriesTicker: 'KXPCECORE',
    label: 'Core PCE',
    assetClass: 'Inflation',
    hedgeyeSignal: 'No exact Hedgeye input wired',
    matchType: 'missing_signal',
    matchLabel: 'Missing signal',
    matchReason: 'Inflation-related, but CPI nowcast values cannot be substituted for core PCE.',
    cadence: 'Monthly',
    occurrencesPerMonth: 1,
    horizonDays: 370,
    researchPriority: 24,
  },
  {
    seriesTicker: 'KXGDP',
    label: 'US GDP growth',
    assetClass: 'Growth',
    hedgeyeSignal: 'No exact Hedgeye input wired',
    matchType: 'missing_signal',
    matchLabel: 'Missing signal',
    matchReason: 'Quarterly release needs an exact GDP nowcast or forecast range.',
    cadence: 'Quarterly',
    occurrencesPerMonth: 0.3,
    horizonDays: 400,
    researchPriority: 25,
  },
];

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sumField(markets, ...keys) {
  return markets.reduce((total, market) => {
    for (const key of keys) {
      const value = finiteNumber(market[key]);
      if (value != null) return total + value;
    }
    return total;
  }, 0);
}

function sumHundredths(items = [], key) {
  return items.reduce((sum, item) => sum + Math.round((finiteNumber(item?.[key]) || 0) * 100), 0) / 100;
}

function marketPrice(market, dollarsKey, centsKey) {
  const dollars = finiteNumber(market[dollarsKey]);
  if (dollars != null) return dollars;
  const cents = finiteNumber(market[centsKey]);
  return cents == null ? null : cents / 100;
}

function marketBook(market = {}) {
  const yesBid = marketPrice(market, 'yes_bid_dollars', 'yes_bid');
  const yesAsk = marketPrice(market, 'yes_ask_dollars', 'yes_ask');
  const yesBidSize = finiteNumber(market.yes_bid_size_fp ?? market.yes_bid_size);
  const yesAskSize = finiteNumber(market.yes_ask_size_fp ?? market.yes_ask_size);
  const noBid = marketPrice(market, 'no_bid_dollars', 'no_bid');
  const noAsk = marketPrice(market, 'no_ask_dollars', 'no_ask');
  const noBidSize = finiteNumber(market.no_bid_size_fp ?? market.no_bid_size);
  const noAskSize = finiteNumber(market.no_ask_size_fp ?? market.no_ask_size);
  const directQuote = yesBid != null && yesAsk != null && yesBid >= 0 && yesAsk > 0 && yesAsk <= 1 && yesAsk >= yesBid;
  const noDirectQuote = noBid != null && noAsk != null && noBid >= 0 && noAsk > 0 && noAsk <= 1 && noAsk >= noBid;
  return {
    yesBid,
    yesAsk,
    yesBidSize,
    yesAskSize,
    noBid,
    noAsk,
    noBidSize,
    noAskSize,
    directQuote,
    noDirectQuote,
    liveBook: directQuote && noDirectQuote,
    midpoint: directQuote ? (yesBid + yesAsk) / 2 : null,
    spread: directQuote ? yesAsk - yesBid : null,
    noSpread: noDirectQuote ? noAsk - noBid : null,
  };
}

function spxCloseMarketBook(market = {}) {
  const yes = marketBook(market);
  return { ...yes, liveBook: Boolean(yes.directQuote && yes.noDirectQuote) };
}

function normalizeSpxCloseOverviewMarket(market = {}) {
  const book = spxCloseMarketBook(market);
  const threshold = finiteNumber(market.floor_strike);
  if (threshold == null) return null;
  return {
    ticker: market.ticker,
    eventTicker: market.event_ticker,
    title: market.title,
    threshold,
    closeTime: market.close_time,
    expectedExpirationTime: market.expected_expiration_time || null,
    rulesPrimary: market.rules_primary || null,
    status: market.status,
    yesBid: book.directQuote ? book.yesBid : null,
    yesAsk: book.directQuote ? book.yesAsk : null,
    yesBidSize: book.yesBidSize,
    yesAskSize: book.yesAskSize,
    noBid: book.noDirectQuote ? book.noBid : null,
    noAsk: book.noDirectQuote ? book.noAsk : null,
    noBidSize: book.noBidSize,
    noAskSize: book.noAskSize,
    spread: book.spread,
    noSpread: book.noSpread,
    bookStatus: book.liveBook ? 'complete' : 'incomplete',
    nativeBook: {
      yesPrices: book.directQuote,
      noPrices: book.noDirectQuote,
      yesDepth: book.yesBidSize != null && book.yesAskSize != null,
      noDepth: book.noBidSize != null && book.noAskSize != null,
      complete: book.liveBook,
      derivedFields: [],
    },
    volume24h: finiteNumber(market.volume_24h_fp ?? market.volume_24h),
    volumeTotal: finiteNumber(market.volume_fp ?? market.volume),
    openInterest: finiteNumber(market.open_interest_fp ?? market.open_interest),
    updatedAt: market.updated_time || null,
  };
}

function normalizeSpxCloseMarket(market = {}) {
  const normalized = normalizeSpxCloseOverviewMarket(market);
  return normalized?.nativeBook.complete ? normalized : null;
}

function normalizeSettledSpxCloseMarket(market = {}) {
  const threshold = finiteNumber(market.floor_strike);
  const closeValue = finiteNumber(market.expiration_value);
  const settlementPayout = marketPrice(market, 'settlement_value_dollars', 'settlement_value');
  const result = String(market.result || '').toLowerCase();
  const status = String(market.status || '').toLowerCase();
  const completed = status === 'finalized' || status === 'settled';
  const validResult = result === 'yes' || result === 'no';
  const validPayout = settlementPayout === (result === 'yes' ? 1 : 0);
  if (!completed || !validResult || !validPayout || threshold == null || closeValue == null) return null;
  return {
    ticker: market.ticker,
    eventTicker: market.event_ticker,
    title: market.title,
    threshold,
    closeTime: market.close_time,
    settlementTime: market.settlement_ts || null,
    closeValue,
    result,
    settlementPayout,
    rulesPrimary: market.rules_primary || null,
    status,
    volume24h: finiteNumber(market.volume_24h_fp ?? market.volume_24h) || 0,
    volumeTotal: finiteNumber(market.volume_fp ?? market.volume) || 0,
    openInterest: finiteNumber(market.open_interest_fp ?? market.open_interest) || 0,
  };
}

function listSpxCloseEventCandidates(events = [], now = Date.now()) {
  return (events || [])
    .filter((event) => (
      SPX_SETTLED_EVENT_PATTERN.test(String(event?.event_ticker || ''))
    ))
    .map((event) => {
      const markets = (event.markets || []).filter((market) => {
        const closeMs = Date.parse(market.close_time);
        return (
          Number.isFinite(closeMs) &&
          closeMs > now &&
          market.status !== 'closed' &&
          market.status !== 'settled'
        );
      });
      const closeTime = markets.map((market) => market.close_time).sort((a, b) => Date.parse(a) - Date.parse(b))[0] || null;
      return { event, markets, closeTime };
    })
    .filter((candidate) => candidate.markets.length > 0 && candidate.closeTime)
    .sort((a, b) => Date.parse(a.closeTime) - Date.parse(b.closeTime));
}

function selectSpxCloseEvent(events = [], now = Date.now()) {
  return listSpxCloseEventCandidates(events, now)[0] || null;
}

function selectLastSettledSpxCloseEvent(events = [], now = Date.now()) {
  return listSettledSpxCloseEventMetadata(events, now)[0] || null;
}

function listSettledSpxCloseEventMetadata(events = [], now = Date.now(), options = {}) {
  const requireBrokerEnabled = options.requireBrokerEnabled !== false;
  return (events || [])
    .filter((event) => (
      SPX_SETTLED_EVENT_PATTERN.test(String(event?.event_ticker || '')) &&
      (!requireBrokerEnabled || event?.available_on_brokers === true)
    ))
    .map((event) => {
      const markets = (event.markets || [])
        .map(normalizeSettledSpxCloseMarket)
        .filter(Boolean);
      const closeTime = event.strike_date || markets[0]?.closeTime || null;
      return { event, markets, closeTime };
    })
    .filter((candidate) => (
      candidate.closeTime &&
      Date.parse(candidate.closeTime) <= now
    ))
    .sort((a, b) => Date.parse(b.closeTime) - Date.parse(a.closeTime));
}

function clampRecentSpxHistoryLimit(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return SPX_RECENT_SETTLED_DEFAULT_LIMIT;
  return Math.min(SPX_RECENT_SETTLED_MAX_LIMIT, Math.max(1, parsed));
}

async function getSpxCloseWorkbench(options = {}) {
  const deps = {
    kalshiFetch: options.kalshiFetch || kalshiFetch,
    checkGatewayHealth: options.checkGatewayHealth || checkGatewayHealth,
    now: options.now || Date.now,
  };
  const now = deps.now();
  const minCloseTs = Math.floor(now / 1000);
  const maxCloseTs = Math.floor((now + 7 * DAY_MS) / 1000);
  const [data, ibkrHealth] = await Promise.all([
    deps.kalshiFetch('/events', {
      series_ticker: SPX_CLOSE_SERIES_TICKER,
      status: 'open',
      limit: 200,
      min_close_ts: minCloseTs,
      max_close_ts: maxCloseTs,
      with_nested_markets: true,
    }),
    deps.checkGatewayHealth().catch((error) => ({ ok: false, reason: 'health_error', message: error.message })),
  ]);
  const candidates = listSpxCloseEventCandidates(data.events || [], now);
  if (!candidates.length) {
    const error = new Error('Today’s 4 p.m. cash-SPX contract has settled or the next exact KXINXU H1600 event is not listed yet.');
    error.code = 'SPX_EVENT_UNAVAILABLE';
    throw error;
  }
  const fetchedAt = new Date(deps.now()).toISOString();
  let selected = null;
  let overviewMarkets = null;
  let markets = null;
  const allowIncompleteBooks = options.allowIncompleteBooks === true;
  for (const candidate of candidates) {
    const candidateOverviewMarkets = candidate.markets
      .map(normalizeSpxCloseOverviewMarket)
      .filter(Boolean)
      .sort((a, b) => a.threshold - b.threshold);
    const candidateMarkets = candidateOverviewMarkets.filter((market) => market.nativeBook.complete);
    const everyStrikeNormalized = candidateOverviewMarkets.length === candidate.markets.length;
    if (allowIncompleteBooks && everyStrikeNormalized && candidateOverviewMarkets.length > 0) {
      selected = candidate;
      overviewMarkets = candidateOverviewMarkets;
      markets = candidateOverviewMarkets;
      break;
    }
    if (
      candidateMarkets.length > 0 &&
      candidateMarkets.length === candidateOverviewMarkets.length &&
      everyStrikeNormalized
    ) {
      selected = candidate;
      overviewMarkets = candidateOverviewMarkets;
      markets = candidateMarkets;
      break;
    }
  }
  if (!selected) {
    const error = new Error('No exact 4 p.m. cash-SPX event currently has a complete two-sided direct venue book for every active line');
    error.code = 'SPX_BOOK_UNAVAILABLE';
    throw error;
  }
  const event = selected.event;
  return {
    ok: true,
    fetchedAt,
    seriesTicker: SPX_CLOSE_SERIES_TICKER,
    event: {
      ticker: event.event_ticker,
      title: event.title || 'S&P 500 cash close',
      closeTime: selected.closeTime,
      settlementSource: event.settlement_sources?.[0] || null,
      availableOnBrokers: event.available_on_brokers === true,
      totalMarketCount: selected.markets.length,
      quotedMarketCount: markets.filter((market) => market.nativeBook.complete).length,
    },
    markets,
    overviewMarkets,
    venue: {
      name: 'Kalshi',
      source: 'kalshi_trade_api_v2',
      snapshotType: 'direct_venue',
      fetchedAt,
      volume24h: sumHundredths(markets, 'volume24h'),
      volumeTotal: sumHundredths(markets, 'volumeTotal'),
      openInterest: sumHundredths(markets, 'openInterest'),
    },
    ibkr: {
      connected: Boolean(ibkrHealth?.ok),
      authenticated: Boolean(ibkrHealth?.authenticated),
      executionVerified: false,
      status: ibkrHealth?.ok ? 'connected_unverified' : (ibkrHealth?.reason || 'offline'),
      message: ibkrHealth?.ok
        ? 'Gateway connected; this direct Kalshi snapshot is not an IBKR-native executable quote'
        : (ibkrHealth?.message || 'IB Gateway unavailable'),
    },
    policy: {
      researchOnly: true,
      exactUnderlying: 'S&P 500 cash index',
      exactObservation: '4:00 p.m. ET end-of-day index value',
      recommendationAvailable: false,
      incompleteBooksIncluded: allowIncompleteBooks,
      reason: 'Hedgeye Risk Range is not yet calibrated into a closing-threshold probability model',
    },
  };
}

function candleClosePrice(side = {}) {
  return finiteNumber(side.close_dollars ?? side.close);
}

function complementaryPrice(value) {
  return value == null ? null : Number((1 - value).toFixed(4));
}

function normalizeSpxCloseQuoteMarket(market = {}, candle = null, closeTime = null) {
  const threshold = finiteNumber(market.threshold);
  const closeSeconds = Number.isFinite(Date.parse(closeTime))
    ? Math.floor(Date.parse(closeTime) / 1000)
    : null;
  const candleSeconds = finiteNumber(candle?.end_period_ts);
  const yesBid = candleClosePrice(candle?.yes_bid);
  const yesAsk = candleClosePrice(candle?.yes_ask);
  const validYesBook = (
    threshold != null &&
    closeSeconds != null &&
    candleSeconds === closeSeconds &&
    yesBid != null &&
    yesAsk != null &&
    yesBid >= 0 &&
    yesAsk <= 1 &&
    yesAsk >= yesBid
  );
  if (!validYesBook) return null;

  return {
    ticker: market.ticker,
    eventTicker: market.eventTicker,
    title: market.title,
    threshold,
    closeTime: market.closeTime || closeTime,
    yesBid,
    yesAsk,
    noBid: complementaryPrice(yesAsk),
    noAsk: complementaryPrice(yesBid),
    volume24h: market.volume24h || 0,
    volumeTotal: market.volumeTotal || 0,
    openInterest: market.openInterest || 0,
    status: 'closed',
    updatedAt: new Date(closeSeconds * 1000).toISOString(),
    nativeBook: {
      complete: true,
      derivedFields: ['noBid', 'noAsk'],
    },
    quoteProvenance: {
      source: 'kalshi_event_candlestick',
      snapshotType: 'historical_quote_close',
      asOf: new Date(closeSeconds * 1000).toISOString(),
      derivedFields: ['noBid', 'noAsk'],
    },
  };
}

async function getLastSettledSpxCloseQuoteSnapshot(options = {}) {
  const deps = {
    kalshiFetch: options.kalshiFetch || kalshiFetch,
    now: options.now || Date.now,
  };
  const { verified, now } = await fetchVerifiedSettledSpxCloseSessions({ ...options, allowNonBroker: true }, 1, 4);
  const selected = verified[0] || null;
  if (!selected) {
    const error = new Error('No verified previous cash-SPX quote close is available');
    error.code = 'SPX_HISTORY_UNAVAILABLE';
    throw error;
  }

  const closeMs = Date.parse(selected.closeTime);
  if (!Number.isFinite(closeMs)) {
    const error = new Error('The previous cash-SPX event has no verified close timestamp');
    error.code = 'SPX_CLOSE_QUOTES_UNAVAILABLE';
    throw error;
  }
  const closeSeconds = Math.floor(closeMs / 1000);
  const payload = await deps.kalshiFetch(
    `/series/${encodeURIComponent(SPX_CLOSE_SERIES_TICKER)}/events/${encodeURIComponent(selected.event.event_ticker)}/candlesticks`,
    {
      start_ts: closeSeconds - Math.floor(DAY_MS / 1000),
      end_ts: closeSeconds,
      period_interval: 60,
    },
  );
  const tickers = Array.isArray(payload?.market_tickers) ? payload.market_tickers : [];
  const candleSeries = Array.isArray(payload?.market_candlesticks) ? payload.market_candlesticks : [];
  const candlesByTicker = new Map(tickers.map((ticker, index) => [
    ticker,
    Array.isArray(candleSeries[index]) ? candleSeries[index] : [],
  ]));
  const historicalMarkets = selected.markets
    .map((market) => normalizeSpxCloseQuoteMarket(
      market,
      (candlesByTicker.get(market.ticker) || []).find((candle) => finiteNumber(candle?.end_period_ts) === closeSeconds),
      selected.closeTime,
    ))
    .filter(Boolean)
    .sort((left, right) => left.threshold - right.threshold);

  if (!historicalMarkets.length || historicalMarkets.length !== selected.markets.length) {
    const error = new Error('The previous cash-SPX event does not have a verified closing quote candle for every line');
    error.code = 'SPX_CLOSE_QUOTES_UNAVAILABLE';
    throw error;
  }

  const fetchedAt = new Date(now).toISOString();
  const closeTime = new Date(closeMs).toISOString();
  const event = selected.event;
  return {
    ok: true,
    mode: 'closed',
    historicalOnly: true,
    executable: false,
    fetchedAt,
    seriesTicker: SPX_CLOSE_SERIES_TICKER,
    event: {
      ticker: event.event_ticker,
      title: event.title || 'S&P 500 cash close',
      closeTime,
      settlementTime: selected.settlementTime,
      settlementSource: event.settlement_sources?.[0] || null,
      availableOnBrokers: event.available_on_brokers === true,
      totalMarketCount: selected.markets.length,
      quotedMarketCount: historicalMarkets.length,
    },
    markets: historicalMarkets,
    venue: {
      name: 'Kalshi',
      source: 'kalshi_trade_api_v2',
      snapshotType: 'historical_quote_close',
      fetchedAt,
      quoteAsOf: closeTime,
      volume24h: sumHundredths(historicalMarkets, 'volume24h'),
      volumeTotal: sumHundredths(historicalMarkets, 'volumeTotal'),
      openInterest: sumHundredths(historicalMarkets, 'openInterest'),
    },
    policy: {
      researchOnly: true,
      historicalOnly: true,
      executable: false,
      quotesAvailable: true,
      recommendationAvailable: false,
      reason: 'Historical closing quotes are reference data only; NO prices are the exact binary complement of the candle close YES book',
      quoteProvenance: 'kalshi_event_candlestick',
      derivedFields: ['noBid', 'noAsk'],
    },
  };
}

async function getSpxCoverSnapshot(options = {}) {
  try {
    const live = await getSpxCloseWorkbench(options);
    return {
      ...live,
      mode: 'live',
      historicalOnly: false,
      executable: false,
      cover: true,
    };
  } catch (error) {
    if (!['SPX_EVENT_UNAVAILABLE', 'SPX_BOOK_UNAVAILABLE'].includes(error?.code)) throw error;
    try {
      return {
        ...(await getLastSettledSpxCloseQuoteSnapshot(options)),
        cover: true,
      };
    } catch (historyError) {
      historyError.code = 'SPX_COVER_UNAVAILABLE';
      throw historyError;
    }
  }
}

function verifySettledSpxCloseEvent(detailData = {}, metadata = {}, now = Date.now(), options = {}) {
  const requireBrokerEnabled = options.requireBrokerEnabled !== false;
  const event = detailData.event || detailData;
  const eventTicker = String(event?.event_ticker || '');
  const metadataTicker = String(metadata?.event?.event_ticker || '');
  if (
    !SPX_SETTLED_EVENT_PATTERN.test(eventTicker) ||
    eventTicker !== metadataTicker ||
    (requireBrokerEnabled && metadata?.event?.available_on_brokers !== true) ||
    (requireBrokerEnabled && event?.available_on_brokers === false)
  ) return null;

  const rawMarkets = event.markets || detailData.markets || [];
  const markets = rawMarkets.map(normalizeSettledSpxCloseMarket).filter(Boolean);
  const closeValues = new Set(markets.map((market) => market.closeValue.toFixed(4)));
  const strikes = new Set(markets.map((market) => market.threshold));
  const closeTime = event.strike_date || metadata.closeTime || markets[0]?.closeTime || null;
  const settlementTimes = markets.map((market) => market.settlementTime).filter(Boolean);
  const settlementTime = settlementTimes.sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null;
  const outcomesMatchClose = markets.every((market) => (
    market.result === (market.closeValue >= market.threshold ? 'yes' : 'no')
  ));
  const complete = (
    rawMarkets.length > 0 &&
    markets.length === rawMarkets.length &&
    closeValues.size === 1 &&
    strikes.size === markets.length &&
    markets.every((market) => market.eventTicker === eventTicker) &&
    outcomesMatchClose &&
    settlementTime &&
    Number.isFinite(Date.parse(closeTime)) &&
    Date.parse(closeTime) <= now
  );
  if (!complete) return null;

  return {
    event,
    markets: markets.sort((a, b) => a.threshold - b.threshold),
    closeTime,
    settlementTime,
  };
}

async function fetchSettledSpxCloseMetadata(deps, now, minimumCandidateCount, options = {}) {
  const events = [];
  const seenCursors = new Set();
  let cursor = null;
  for (let page = 0; page < 5; page += 1) {
    const params = {
      series_ticker: SPX_CLOSE_SERIES_TICKER,
      status: 'settled',
      limit: 200,
      min_close_ts: Math.floor((now - 45 * DAY_MS) / 1000),
      with_nested_markets: false,
      ...(cursor ? { cursor } : {}),
    };
    const data = await deps.kalshiFetch('/events', params);
    events.push(...(data.events || []));
    const candidates = listSettledSpxCloseEventMetadata(events, now, options);
    const nextCursor = data.cursor || null;
    if (candidates.length >= minimumCandidateCount || !nextCursor || seenCursors.has(nextCursor)) {
      return candidates;
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  return listSettledSpxCloseEventMetadata(events, now, options);
}

async function fetchVerifiedSettledSpxCloseSessions(options = {}, requestedLimit = 1, detailSlack = 5) {
  const deps = {
    kalshiFetch: options.kalshiFetch || kalshiFetch,
    now: options.now || Date.now,
  };
  const now = deps.now();
  const requireBrokerEnabled = options.allowNonBroker !== true;
  const scanCount = Math.min(SPX_RECENT_SETTLED_MAX_LIMIT + 5, requestedLimit + detailSlack);
  const metadataRows = await fetchSettledSpxCloseMetadata(deps, now, scanCount, { requireBrokerEnabled });
  const candidates = metadataRows.slice(0, scanCount);
  const verified = [];
  for (const metadata of candidates) {
    const detailData = await deps.kalshiFetch(`/events/${metadata.event.event_ticker}`, {
      with_nested_markets: true,
    });
    const session = verifySettledSpxCloseEvent(detailData, metadata, now, { requireBrokerEnabled });
    if (session) verified.push(session);
    if (verified.length >= requestedLimit) break;
  }
  return { verified, now: deps.now() };
}

async function getLastSettledSpxCloseSession(options = {}) {
  const { verified, now } = await fetchVerifiedSettledSpxCloseSessions(options, 1, 4);
  const selected = verified[0] || null;
  if (!selected) {
    const error = new Error('No completed broker-enabled 4 p.m. cash-SPX session is available');
    error.code = 'SPX_HISTORY_UNAVAILABLE';
    throw error;
  }
  const closeValue = selected.markets[0].closeValue;
  const markets = selected.markets
    .filter((market) => Math.abs(market.closeValue - closeValue) < 0.000001)
    .sort((a, b) => a.threshold - b.threshold);
  if (!markets.length) {
    const error = new Error('The latest completed cash-SPX session has no verified settlement outcomes');
    error.code = 'SPX_HISTORY_UNAVAILABLE';
    throw error;
  }
  const event = selected.event;
  const fetchedAt = new Date(now).toISOString();
  return {
    ok: true,
    historicalOnly: true,
    executable: false,
    fetchedAt,
    seriesTicker: SPX_CLOSE_SERIES_TICKER,
    event: {
      ticker: event.event_ticker,
      title: event.title || 'S&P 500 cash close',
      closeTime: selected.closeTime,
      settlementTime: selected.settlementTime,
      settlementSource: event.settlement_sources?.[0] || null,
      availableOnBrokersAtSettlement: true,
      marketCount: markets.length,
    },
    closeValue,
    markets,
    venue: {
      name: 'Kalshi',
      source: 'kalshi_trade_api_v2',
      snapshotType: 'settled_outcome',
      fetchedAt,
      volume24h: sumHundredths(markets, 'volume24h'),
      volumeTotal: sumHundredths(markets, 'volumeTotal'),
      openInterest: sumHundredths(markets, 'openInterest'),
    },
    policy: {
      historicalOnly: true,
      executable: false,
      quotesAvailable: false,
      recommendationAvailable: false,
      reason: 'Settled outcomes are historical reference data, never executable quotes',
    },
  };
}

async function getRecentSettledSpxCloseSessions(options = {}) {
  const normalizedOptions = typeof options === 'number' ? { limit: options } : options;
  const limit = clampRecentSpxHistoryLimit(normalizedOptions.limit);
  const { verified, now } = await fetchVerifiedSettledSpxCloseSessions(normalizedOptions, limit, 5);
  if (!verified.length) {
    const error = new Error('No completed broker-enabled 4 p.m. cash-SPX sessions are available');
    error.code = 'SPX_HISTORY_UNAVAILABLE';
    throw error;
  }
  const fetchedAt = new Date(now).toISOString();
  const sessions = verified.slice(0, limit).map((session) => ({
    eventTicker: session.event.event_ticker,
    closeTime: session.closeTime,
    settlementTime: session.settlementTime,
    closeValue: session.markets[0].closeValue,
    marketCount: session.markets.length,
    historicalOnly: true,
    executable: false,
    snapshotType: 'settled_outcome',
    venue: {
      name: 'Kalshi',
      source: 'kalshi_trade_api_v2',
      snapshotType: 'settled_outcome',
      volumeTotal: sumHundredths(session.markets, 'volumeTotal'),
      openInterest: sumHundredths(session.markets, 'openInterest'),
    },
  }));
  return {
    ok: true,
    historicalOnly: true,
    executable: false,
    snapshotType: 'settled_outcome',
    fetchedAt,
    seriesTicker: SPX_CLOSE_SERIES_TICKER,
    requestedLimit: limit,
    returnedCount: sessions.length,
    sessions,
    policy: {
      historicalOnly: true,
      executable: false,
      quotesAvailable: false,
      recommendationAvailable: false,
      reason: 'Settled outcomes are historical reference data, never executable quotes',
    },
  };
}

function normalizeWtiCadence(value = 'daily') {
  const cadence = String(value || 'daily').trim().toLowerCase();
  if (!WTI_CADENCE_CONFIG[cadence]) {
    const error = new Error('WTI cadence must be either daily or weekly');
    error.code = 'WTI_INVALID_CADENCE';
    throw error;
  }
  return cadence;
}

function wtiCadenceConfig(value = 'daily') {
  return WTI_CADENCE_CONFIG[normalizeWtiCadence(value)];
}

function directBinaryBook(market = {}) {
  const yesBid = marketPrice(market, 'yes_bid_dollars', 'yes_bid');
  const yesAsk = marketPrice(market, 'yes_ask_dollars', 'yes_ask');
  const noBid = marketPrice(market, 'no_bid_dollars', 'no_bid');
  const noAsk = marketPrice(market, 'no_ask_dollars', 'no_ask');
  const yesBidSize = finiteNumber(market.yes_bid_size_fp ?? market.yes_bid_size);
  const yesAskSize = finiteNumber(market.yes_ask_size_fp ?? market.yes_ask_size);
  const noBidSize = finiteNumber(market.no_bid_size_fp ?? market.no_bid_size);
  const noAskSize = finiteNumber(market.no_ask_size_fp ?? market.no_ask_size);
  const validPrice = (value) => value != null && value >= 0 && value <= 1;
  const yesPricesDirect = validPrice(yesBid) && validPrice(yesAsk) && yesAsk >= yesBid;
  const noPricesDirect = validPrice(noBid) && validPrice(noAsk) && noAsk >= noBid;
  const yesDepthDirect = yesBidSize != null && yesAskSize != null && yesBidSize > 0 && yesAskSize > 0;
  const noDepthDirect = noBidSize != null && noAskSize != null && noBidSize > 0 && noAskSize > 0;
  return {
    yesBid,
    yesAsk,
    yesBidSize,
    yesAskSize,
    noBid,
    noAsk,
    noBidSize,
    noAskSize,
    yesPricesDirect,
    noPricesDirect,
    yesDepthDirect,
    noDepthDirect,
    completeBook: Boolean(yesPricesDirect && noPricesDirect && yesDepthDirect),
    spread: yesPricesDirect ? Number((yesAsk - yesBid).toFixed(4)) : null,
  };
}

function normalizeWtiGeometry(market = {}, cadence = 'daily') {
  const normalizedCadence = normalizeWtiCadence(cadence);
  const strikeType = String(market.strike_type || '').toLowerCase();
  const floor = finiteNumber(market.floor_strike);
  const cap = finiteNumber(market.cap_strike);

  if (normalizedCadence === 'daily') {
    if (strikeType !== 'greater' || floor == null || cap != null) return null;
    return {
      kind: 'above',
      strikeType: 'greater',
      threshold: floor,
      lowerBound: floor,
      upperBound: null,
      lowerInclusive: false,
      upperInclusive: false,
    };
  }

  if (strikeType === 'less' && floor == null && cap != null) {
    return {
      kind: 'lower_tail',
      strikeType: 'less',
      threshold: cap,
      lowerBound: null,
      upperBound: cap,
      lowerInclusive: false,
      upperInclusive: false,
    };
  }
  if (strikeType === 'between' && floor != null && cap != null && floor <= cap) {
    return {
      kind: 'bucket',
      strikeType: 'between',
      threshold: null,
      lowerBound: floor,
      upperBound: cap,
      lowerInclusive: true,
      upperInclusive: true,
    };
  }
  if (strikeType === 'greater' && floor != null && cap == null) {
    return {
      kind: 'upper_tail',
      strikeType: 'greater',
      threshold: floor,
      lowerBound: floor,
      upperBound: null,
      lowerInclusive: false,
      upperInclusive: false,
    };
  }
  return null;
}

function wtiGeometrySortValue(geometry = {}) {
  if (geometry.kind === 'lower_tail') return Number.NEGATIVE_INFINITY;
  return geometry.lowerBound ?? geometry.threshold ?? Number.POSITIVE_INFINITY;
}

function normalizeWtiMarket(market = {}, cadence = 'daily') {
  const geometry = normalizeWtiGeometry(market, cadence);
  if (!geometry || !market.ticker || !market.event_ticker) return null;
  const book = directBinaryBook(market);
  return {
    ticker: market.ticker,
    eventTicker: market.event_ticker,
    title: market.title || null,
    subtitle: market.subtitle || null,
    cadence: normalizeWtiCadence(cadence),
    geometry,
    geometryType: geometry.kind,
    strikeType: geometry.strikeType,
    threshold: geometry.threshold,
    lowerBound: geometry.lowerBound,
    upperBound: geometry.upperBound,
    lowerInclusive: geometry.lowerInclusive,
    upperInclusive: geometry.upperInclusive,
    closeTime: market.close_time || null,
    expectedExpirationTime: market.expected_expiration_time || null,
    status: market.status || null,
    rulesPrimary: market.rules_primary || null,
    rulesSecondary: market.rules_secondary || null,
    customStrike: market.custom_strike ? {
      frontMonthContract: market.custom_strike.front_month_contract || null,
      strikeDate: market.custom_strike.strike_date || null,
    } : null,
    yesBid: book.yesPricesDirect ? book.yesBid : null,
    yesAsk: book.yesPricesDirect ? book.yesAsk : null,
    yesBidSize: book.yesBidSize,
    yesAskSize: book.yesAskSize,
    noBid: book.noPricesDirect ? book.noBid : null,
    noAsk: book.noPricesDirect ? book.noAsk : null,
    noBidSize: book.noBidSize,
    noAskSize: book.noAskSize,
    bookStatus: book.completeBook ? 'complete' : 'incomplete',
    nativeBook: {
      yesPrices: book.yesPricesDirect,
      noPrices: book.noPricesDirect,
      yesDepth: book.yesDepthDirect,
      noDepth: book.noDepthDirect,
      complete: book.completeBook,
      derivedFields: [],
    },
    spread: book.spread,
    volume24h: finiteNumber(market.volume_24h_fp ?? market.volume_24h) || 0,
    volumeTotal: finiteNumber(market.volume_fp ?? market.volume) || 0,
    openInterest: finiteNumber(market.open_interest_fp ?? market.open_interest) || 0,
    updatedAt: market.updated_time || null,
  };
}

function validateWtiGeometry(markets = [], cadence = 'daily') {
  const normalizedCadence = normalizeWtiCadence(cadence);
  if (!markets.length) return false;
  const uniqueTickers = new Set(markets.map((market) => market.ticker));
  if (uniqueTickers.size !== markets.length) return false;

  if (normalizedCadence === 'daily') {
    const thresholds = markets.map((market) => market.geometry?.threshold);
    return markets.every((market) => market.geometry?.kind === 'above') &&
      thresholds.every(Number.isFinite) &&
      new Set(thresholds).size === thresholds.length;
  }

  const lowerTails = markets.filter((market) => market.geometry?.kind === 'lower_tail');
  const buckets = markets
    .filter((market) => market.geometry?.kind === 'bucket')
    .sort((a, b) => a.geometry.lowerBound - b.geometry.lowerBound);
  const upperTails = markets.filter((market) => market.geometry?.kind === 'upper_tail');
  if (lowerTails.length !== 1 || upperTails.length !== 1 || !buckets.length) return false;
  if (lowerTails[0].geometry.upperBound !== buckets[0].geometry.lowerBound) return false;
  if (upperTails[0].geometry.lowerBound !== buckets[buckets.length - 1].geometry.upperBound) return false;
  return buckets.every((market, index) => {
    if (index === 0) return true;
    const priorCapCents = Math.round(buckets[index - 1].geometry.upperBound * 100);
    const floorCents = Math.round(market.geometry.lowerBound * 100);
    return priorCapCents + 1 === floorCents;
  });
}

function uniqueNonEmpty(values = []) {
  return [...new Set(values.filter((value) => value != null && value !== ''))];
}

function parseWtiContractDescription(rulesPrimary = '') {
  const match = String(rulesPrimary).match(/WTI crude oil\s*\(([^)]+contract)\)/i);
  return match ? match[1].trim() : null;
}

function parseWtiUnits(rulesPrimary = '') {
  const match = String(rulesPrimary).match(/\b(USD\/Bbl)\b/i);
  return match ? match[1] : null;
}

function parseWtiPrecision(rulesSecondary = '') {
  const match = String(rulesSecondary).match(/rounded to the nearest\s+(\d+)\s+decimal places?/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

function buildWtiSettlementMapping(event = {}, rawMarkets = []) {
  const sources = event.settlement_sources || [];
  const frontMonthContracts = uniqueNonEmpty(rawMarkets.map((market) => market.custom_strike?.front_month_contract));
  const observationTimes = uniqueNonEmpty(rawMarkets.map((market) => market.custom_strike?.strike_date));
  const contractDescriptions = uniqueNonEmpty(rawMarkets.map((market) => parseWtiContractDescription(market.rules_primary)));
  const units = uniqueNonEmpty(rawMarkets.map((market) => parseWtiUnits(market.rules_primary)));
  const precisions = uniqueNonEmpty(rawMarkets.map((market) => parseWtiPrecision(market.rules_secondary)));
  const ruleSets = uniqueNonEmpty(rawMarkets.map((market) => market.rules_secondary || null));
  const rollRules = ruleSets.filter((rules) => /rolling forward|active month switches|roll/i.test(rules));
  const inconsistent = [frontMonthContracts, observationTimes, contractDescriptions, units, precisions, ruleSets]
    .some((values) => values.length > 1) || sources.length !== 1;
  const incomplete = !sources[0]?.name || !sources[0]?.url || frontMonthContracts.length !== 1 || observationTimes.length !== 1 ||
    contractDescriptions.length !== 1 || units.length !== 1 || precisions.length !== 1;
  const status = inconsistent ? 'inconsistent' : (incomplete ? 'incomplete' : 'consistent_unverified');
  const observationTime = observationTimes.length === 1 ? observationTimes[0] : null;
  const contractDescription = contractDescriptions.length === 1 ? contractDescriptions[0] : null;
  const contractMonth = contractDescription?.replace(/\s+contract$/i, '') || null;

  const frontMonthContract = frontMonthContracts.length === 1 ? frontMonthContracts[0] : null;
  const unitsValue = units.length === 1 ? units[0] : null;
  const precisionDecimals = precisions.length === 1 ? precisions[0] : null;
  return {
    status,
    calibrationAvailable: false,
    proxyCalibrationAvailable: false,
    source: sources.length === 1 ? {
      name: sources[0].name || null,
      url: sources[0].url || null,
    } : null,
    frontMonthContract,
    contractLabel: frontMonthContract,
    contractDescription,
    contractMonth,
    observationTime,
    observation: observationTime,
    eventDate: observationTime ? observationTime.slice(0, 10) : null,
    units: unitsValue,
    unit: unitsValue,
    precisionDecimals,
    precision: precisionDecimals,
    rollConvention: rollRules.length === 1 ? rollRules[0] : null,
    rulesSecondary: ruleSets.length === 1 ? ruleSets[0] : null,
    reason: inconsistent
      ? 'WTI settlement metadata differs across contracts; calibration is disabled'
      : (incomplete
        ? 'WTI settlement metadata is incomplete; calibration is disabled'
        : 'ICE contract metadata is internally consistent but has not been approved as a Hedgeye WTIC calibration mapping'),
  };
}

function selectWtiEvent(events = [], cadence = 'daily', now = Date.now()) {
  const config = wtiCadenceConfig(cadence);
  return (events || [])
    .filter((event) => {
      const ticker = String(event?.event_ticker || '');
      const exactSeries = event?.series_ticker
        ? event.series_ticker === config.seriesTicker
        : ticker.startsWith(`${config.seriesTicker}-`);
      const geometryMatches = typeof event?.mutually_exclusive !== 'boolean' ||
        event.mutually_exclusive === config.mutuallyExclusive;
      return exactSeries && ticker.startsWith(`${config.seriesTicker}-`) &&
        geometryMatches && event?.available_on_brokers === true;
    })
    .map((event) => {
      const markets = (event.markets || []).filter((market) => {
        const closeMs = Date.parse(market.close_time);
        const status = String(market.status || '').toLowerCase();
        return market.event_ticker === event.event_ticker && Number.isFinite(closeMs) && closeMs > now &&
          !['closed', 'settled', 'finalized'].includes(status);
      });
      const closeTime = markets
        .map((market) => market.close_time)
        .sort((a, b) => Date.parse(a) - Date.parse(b))[0] || null;
      return { event, markets, closeTime };
    })
    .filter((candidate) => candidate.markets.length > 0 && candidate.closeTime)
    .sort((a, b) => Date.parse(a.closeTime) - Date.parse(b.closeTime))[0] || null;
}

function wtiContextUnavailable(eventDate) {
  return {
    riskRange: {
      status: 'unavailable',
      ticker: 'WTIC',
      requiredDate: eventDate || null,
      values: null,
      reason: 'No date-matched Hedgeye WTIC Risk Range is attached to this direct venue response',
    },
    ovx: {
      status: 'unavailable',
      symbol: 'OVX',
      value: null,
      reason: 'No verified current OVX observation is attached to this direct venue response',
    },
  };
}

async function getWtiWorkbench(options = {}) {
  const cadence = normalizeWtiCadence(options.cadence);
  const config = WTI_CADENCE_CONFIG[cadence];
  const deps = {
    kalshiFetch: options.kalshiFetch || kalshiFetch,
    checkGatewayHealth: options.checkGatewayHealth || checkGatewayHealth,
    now: options.now || Date.now,
  };
  const now = deps.now();
  const [data, ibkrHealth] = await Promise.all([
    deps.kalshiFetch('/events', {
      series_ticker: config.seriesTicker,
      status: 'open',
      limit: 200,
      min_close_ts: Math.floor(now / 1000),
      max_close_ts: Math.floor((now + config.horizonDays * DAY_MS) / 1000),
      with_nested_markets: true,
    }),
    deps.checkGatewayHealth().catch((error) => ({ ok: false, reason: 'health_error', message: error.message })),
  ]);
  const selected = selectWtiEvent(data.events || [], cadence, now);
  if (!selected) {
    const error = new Error(`No open broker-enabled ${config.seriesTicker} event is available for the ${cadence} WTI view`);
    error.code = 'WTI_EVENT_UNAVAILABLE';
    throw error;
  }

  const normalized = selected.markets.map((market) => normalizeWtiMarket(market, cadence));
  const parsedMarkets = normalized.filter(Boolean);
  const closeTimes = uniqueNonEmpty(selected.markets.map((market) => market.close_time));
  if (!parsedMarkets.length || closeTimes.length !== 1) {
    const error = new Error(`The current ${config.seriesTicker} event has invalid or incomplete ${cadence} settlement geometry`);
    error.code = 'WTI_GEOMETRY_UNAVAILABLE';
    throw error;
  }
  const geometryStatus = normalized.some((market) => !market) || !validateWtiGeometry(parsedMarkets, cadence)
    ? 'partial'
    : 'complete';
  const markets = parsedMarkets.sort((a, b) => wtiGeometrySortValue(a.geometry) - wtiGeometrySortValue(b.geometry));
  const completeBookCount = markets.filter((market) => market.nativeBook.complete).length;
  const directBookCount = markets.filter((market) => market.nativeBook.yesPrices || market.nativeBook.noPrices).length;
  if (!directBookCount) {
    const error = new Error(`The current ${config.seriesTicker} event has no direct native venue prices`);
    error.code = 'WTI_BOOK_UNAVAILABLE';
    throw error;
  }

  const fetchedAt = new Date(deps.now()).toISOString();
  const settlementMapping = buildWtiSettlementMapping(selected.event, selected.markets);
  const eventDate = settlementMapping.eventDate || selected.closeTime?.slice(0, 10) || null;
  const context = wtiContextUnavailable(eventDate);
  return {
    ok: true,
    cadence,
    seriesTicker: config.seriesTicker,
    fetchedAt,
    historicalOnly: false,
    executable: false,
    event: {
      ticker: selected.event.event_ticker,
      seriesTicker: config.seriesTicker,
      title: selected.event.title || config.label,
      status: 'open',
      eventDate,
      strikeDate: settlementMapping.observationTime,
      closeTime: selected.closeTime,
      observationTime: settlementMapping.observationTime,
      expectedExpirationTime: markets[0]?.expectedExpirationTime || null,
      settlementSource: settlementMapping.source,
      mutuallyExclusive: config.mutuallyExclusive,
      availableOnBrokers: true,
      totalMarketCount: selected.markets.length,
      parsedMarketCount: markets.length,
      rejectedMarketCount: selected.markets.length - markets.length,
      geometryStatus,
      quotedMarketCount: markets.filter((market) => market.nativeBook.yesPrices && market.nativeBook.noPrices).length,
      completeBookCount,
    },
    markets,
    settlementMapping,
    ...context,
    venue: {
      name: 'Kalshi',
      source: 'kalshi_trade_api_v2',
      snapshotType: 'direct_venue',
      fetchedAt,
      updatedAt: latestIso(markets.map((market) => market.updatedAt)),
      marketCount: markets.length,
      completeBookCount,
      volume24h: sumHundredths(markets, 'volume24h'),
      volumeTotal: sumHundredths(markets, 'volumeTotal'),
      openInterest: sumHundredths(markets, 'openInterest'),
    },
    ibkr: {
      connected: Boolean(ibkrHealth?.ok),
      authenticated: Boolean(ibkrHealth?.authenticated),
      executionVerified: false,
      status: ibkrHealth?.ok ? 'connected_unverified' : (ibkrHealth?.reason || 'offline'),
      message: ibkrHealth?.ok
        ? 'Gateway connected; this direct Kalshi snapshot is not an IBKR-native executable quote'
        : (ibkrHealth?.message || 'IB Gateway unavailable'),
    },
    policy: {
      researchOnly: true,
      executable: false,
      recommendationAvailable: false,
      fairProbabilityAvailable: false,
      sizingAvailable: false,
      directVenuePricesOnly: true,
      derivedQuoteFields: [],
      reason: 'Exact ICE contract mapping and a WTI settlement probability model have not been validated',
    },
  };
}

function normalizeSettledWtiMarket(market = {}, cadence = 'daily') {
  const geometry = normalizeWtiGeometry(market, cadence);
  const settlementValue = finiteNumber(market.expiration_value);
  const settlementPayout = marketPrice(market, 'settlement_value_dollars', 'settlement_value');
  const result = String(market.result || '').toLowerCase();
  const status = String(market.status || '').toLowerCase();
  const completed = status === 'finalized' || status === 'settled';
  const validResult = result === 'yes' || result === 'no';
  const validPayout = settlementPayout === (result === 'yes' ? 1 : 0);
  if (!geometry || settlementValue == null || !completed || !validResult || !validPayout) return null;
  return {
    ticker: market.ticker,
    eventTicker: market.event_ticker,
    title: market.title || null,
    cadence: normalizeWtiCadence(cadence),
    geometry,
    geometryType: geometry.kind,
    strikeType: geometry.strikeType,
    threshold: geometry.threshold,
    lowerBound: geometry.lowerBound,
    upperBound: geometry.upperBound,
    lowerInclusive: geometry.lowerInclusive,
    upperInclusive: geometry.upperInclusive,
    closeTime: market.close_time || null,
    settlementTime: market.settlement_ts || null,
    settlementValue,
    result,
    settlementPayout,
    rulesPrimary: market.rules_primary || null,
    rulesSecondary: market.rules_secondary || null,
    customStrike: market.custom_strike ? {
      frontMonthContract: market.custom_strike.front_month_contract || null,
      strikeDate: market.custom_strike.strike_date || null,
    } : null,
    status,
    volume24h: finiteNumber(market.volume_24h_fp ?? market.volume_24h) || 0,
    volumeTotal: finiteNumber(market.volume_fp ?? market.volume) || 0,
    openInterest: finiteNumber(market.open_interest_fp ?? market.open_interest) || 0,
  };
}

function wtiOutcomeForGeometry(settlementValue, geometry = {}) {
  if (!Number.isFinite(settlementValue)) return null;
  if (geometry.kind === 'above' || geometry.kind === 'upper_tail') {
    return settlementValue > geometry.threshold;
  }
  if (geometry.kind === 'lower_tail') {
    return settlementValue < geometry.upperBound;
  }
  if (geometry.kind === 'bucket') {
    return settlementValue >= geometry.lowerBound && settlementValue <= geometry.upperBound;
  }
  return null;
}

function listSettledWtiEventMetadata(events = [], cadence = 'daily', now = Date.now()) {
  const config = wtiCadenceConfig(cadence);
  return (events || [])
    .filter((event) => {
      const ticker = String(event?.event_ticker || '');
      const exactSeries = event?.series_ticker
        ? event.series_ticker === config.seriesTicker
        : ticker.startsWith(`${config.seriesTicker}-`);
      const geometryMatches = typeof event?.mutually_exclusive !== 'boolean' ||
        event.mutually_exclusive === config.mutuallyExclusive;
      return exactSeries && ticker.startsWith(`${config.seriesTicker}-`) && geometryMatches &&
        event?.available_on_brokers === true;
    })
    .map((event) => ({
      event,
      closeTime: event.strike_date || null,
    }))
    .filter((candidate) => Number.isFinite(Date.parse(candidate.closeTime)) && Date.parse(candidate.closeTime) <= now)
    .sort((a, b) => Date.parse(b.closeTime) - Date.parse(a.closeTime));
}

function verifySettledWtiEvent(detailData = {}, metadata = {}, cadence = 'daily', now = Date.now()) {
  const config = wtiCadenceConfig(cadence);
  const event = detailData.event || detailData;
  const eventTicker = String(event?.event_ticker || '');
  const metadataTicker = String(metadata?.event?.event_ticker || '');
  const exactSeries = event?.series_ticker
    ? event.series_ticker === config.seriesTicker
    : eventTicker.startsWith(`${config.seriesTicker}-`);
  if (
    !exactSeries ||
    !eventTicker.startsWith(`${config.seriesTicker}-`) ||
    eventTicker !== metadataTicker ||
    metadata?.event?.available_on_brokers !== true ||
    event?.available_on_brokers === false ||
    (typeof event?.mutually_exclusive === 'boolean' && event.mutually_exclusive !== config.mutuallyExclusive)
  ) return null;

  const rawMarkets = event.markets || detailData.markets || [];
  const markets = rawMarkets.map((market) => normalizeSettledWtiMarket(market, cadence));
  if (markets.some((market) => !market)) return null;
  const normalizedMarkets = markets.filter(Boolean);
  const settlementValues = new Set(normalizedMarkets.map((market) => market.settlementValue.toFixed(8)));
  const closeTime = event.strike_date || metadata.closeTime || normalizedMarkets[0]?.closeTime || null;
  const settlementTimes = uniqueNonEmpty(normalizedMarkets.map((market) => market.settlementTime));
  const marketCloseTimes = uniqueNonEmpty(normalizedMarkets.map((market) => market.closeTime));
  const mapping = buildWtiSettlementMapping(event, rawMarkets);
  const outcomesMatch = normalizedMarkets.every((market) => {
    const expectedYes = wtiOutcomeForGeometry(market.settlementValue, market.geometry);
    return expectedYes != null && market.result === (expectedYes ? 'yes' : 'no');
  });
  const complete = rawMarkets.length > 0 &&
    settlementValues.size === 1 &&
    settlementTimes.length === 1 &&
    marketCloseTimes.length === 1 &&
    Date.parse(marketCloseTimes[0]) === Date.parse(closeTime) &&
    normalizedMarkets.every((market) => market.eventTicker === eventTicker) &&
    validateWtiGeometry(normalizedMarkets, cadence) &&
    outcomesMatch &&
    mapping.status === 'consistent_unverified' &&
    Number.isFinite(Date.parse(closeTime)) && Date.parse(closeTime) <= now;
  if (!complete) return null;

  return {
    event,
    markets: normalizedMarkets.sort((a, b) => wtiGeometrySortValue(a.geometry) - wtiGeometrySortValue(b.geometry)),
    closeTime,
    settlementTime: settlementTimes[0],
    settlementValue: normalizedMarkets[0].settlementValue,
    settlementMapping: mapping,
  };
}

function clampRecentWtiHistoryLimit(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return WTI_RECENT_SETTLED_DEFAULT_LIMIT;
  return Math.min(WTI_RECENT_SETTLED_MAX_LIMIT, Math.max(1, parsed));
}

async function fetchSettledWtiMetadata(deps, cadence, now, minimumCandidateCount) {
  const config = WTI_CADENCE_CONFIG[cadence];
  const events = [];
  const seenCursors = new Set();
  let cursor = null;
  for (let page = 0; page < 5; page += 1) {
    const data = await deps.kalshiFetch('/events', {
      series_ticker: config.seriesTicker,
      status: 'settled',
      limit: 200,
      min_close_ts: Math.floor((now - config.historyLookbackDays * DAY_MS) / 1000),
      with_nested_markets: false,
      ...(cursor ? { cursor } : {}),
    });
    events.push(...(data.events || []));
    const candidates = listSettledWtiEventMetadata(events, cadence, now);
    const nextCursor = data.cursor || null;
    if (candidates.length >= minimumCandidateCount || !nextCursor || seenCursors.has(nextCursor)) {
      return candidates;
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  return listSettledWtiEventMetadata(events, cadence, now);
}

async function fetchVerifiedSettledWtiSessions(options = {}, requestedLimit = 1, detailSlack = 5) {
  const cadence = normalizeWtiCadence(options.cadence);
  const deps = {
    kalshiFetch: options.kalshiFetch || kalshiFetch,
    now: options.now || Date.now,
  };
  const now = deps.now();
  const scanCount = Math.min(
    WTI_SETTLED_DETAIL_SCAN_MAX,
    Math.max(requestedLimit + detailSlack, WTI_RECENT_SETTLED_MAX_LIMIT + detailSlack),
  );
  const metadataRows = await fetchSettledWtiMetadata(deps, cadence, now, scanCount);
  const verified = [];
  for (const metadata of metadataRows.slice(0, WTI_SETTLED_DETAIL_SCAN_MAX)) {
    const detailData = await deps.kalshiFetch(`/events/${metadata.event.event_ticker}`, {
      with_nested_markets: true,
    });
    const session = verifySettledWtiEvent(detailData, metadata, cadence, now);
    if (session) verified.push(session);
    if (verified.length >= requestedLimit) break;
  }
  return { cadence, verified, now: deps.now() };
}

function wtiHistoricalPolicy() {
  return {
    historicalOnly: true,
    executable: false,
    quotesAvailable: false,
    recommendationAvailable: false,
    fairProbabilityAvailable: false,
    sizingAvailable: false,
    reason: 'Settled outcomes are historical reference data and contain no executable quote fields',
  };
}

async function getLastSettledWtiSession(options = {}) {
  const { cadence, verified, now } = await fetchVerifiedSettledWtiSessions(options, 1, 5);
  const selected = verified[0] || null;
  if (!selected) {
    const error = new Error(`No fully verified settled ${cadence} WTI session is available`);
    error.code = 'WTI_HISTORY_UNAVAILABLE';
    throw error;
  }
  const config = WTI_CADENCE_CONFIG[cadence];
  const fetchedAt = new Date(now).toISOString();
  const context = wtiContextUnavailable(selected.settlementMapping.eventDate);
  return {
    ok: true,
    cadence,
    seriesTicker: config.seriesTicker,
    historicalOnly: true,
    executable: false,
    snapshotType: 'settled_outcome',
    fetchedAt,
    event: {
      ticker: selected.event.event_ticker,
      seriesTicker: config.seriesTicker,
      title: selected.event.title || config.label,
      status: 'settled',
      eventDate: selected.settlementMapping.eventDate,
      strikeDate: selected.settlementMapping.observationTime,
      closeTime: selected.closeTime,
      settlementTime: selected.settlementTime,
      settlementSource: selected.settlementMapping.source,
      mutuallyExclusive: config.mutuallyExclusive,
      availableOnBrokersAtSettlement: true,
      marketCount: selected.markets.length,
    },
    settlementValue: selected.settlementValue,
    markets: selected.markets,
    settlementMapping: selected.settlementMapping,
    ...context,
    venue: {
      name: 'Kalshi',
      source: 'kalshi_trade_api_v2',
      snapshotType: 'settled_outcome',
      fetchedAt,
      volume24h: sumHundredths(selected.markets, 'volume24h'),
      volumeTotal: sumHundredths(selected.markets, 'volumeTotal'),
      openInterest: sumHundredths(selected.markets, 'openInterest'),
    },
    policy: wtiHistoricalPolicy(),
  };
}

async function getRecentSettledWtiSessions(options = {}) {
  const normalizedOptions = typeof options === 'number' ? { limit: options } : options;
  const limit = clampRecentWtiHistoryLimit(normalizedOptions.limit);
  const { cadence, verified, now } = await fetchVerifiedSettledWtiSessions(normalizedOptions, limit, 5);
  if (!verified.length) {
    const error = new Error(`No fully verified settled ${cadence} WTI sessions are available`);
    error.code = 'WTI_HISTORY_UNAVAILABLE';
    throw error;
  }
  const config = WTI_CADENCE_CONFIG[cadence];
  const sessions = verified.slice(0, limit).map((session) => ({
    eventTicker: session.event.event_ticker,
    eventDate: session.settlementMapping.eventDate,
    closeTime: session.closeTime,
    settlementTime: session.settlementTime,
    settlementValue: session.settlementValue,
    frontMonthContract: session.settlementMapping.frontMonthContract,
    contractMonth: session.settlementMapping.contractMonth,
    marketCount: session.markets.length,
    historicalOnly: true,
    executable: false,
    snapshotType: 'settled_outcome',
    venue: {
      name: 'Kalshi',
      source: 'kalshi_trade_api_v2',
      snapshotType: 'settled_outcome',
      volumeTotal: sumHundredths(session.markets, 'volumeTotal'),
      openInterest: sumHundredths(session.markets, 'openInterest'),
    },
  }));
  return {
    ok: true,
    cadence,
    seriesTicker: config.seriesTicker,
    historicalOnly: true,
    executable: false,
    snapshotType: 'settled_outcome',
    fetchedAt: new Date(now).toISOString(),
    requestedLimit: limit,
    returnedCount: sessions.length,
    sessions,
    policy: wtiHistoricalPolicy(),
  };
}

function highestVolumeCompleteMarket(markets = []) {
  return markets
    .filter((market) => market.nativeBook?.complete !== false)
    .sort((a, b) => {
      const volume24hDelta = (b.volume24h || 0) - (a.volume24h || 0);
      if (volume24hDelta) return volume24hDelta;
      return (b.volumeTotal || 0) - (a.volumeTotal || 0);
    })[0] || null;
}

function overviewLineSortValue(market = {}) {
  if (Number.isFinite(Number(market.geometry?.lowerBound))) return Number(market.geometry.lowerBound);
  if (market.geometry?.kind === 'lower_tail') return Number.NEGATIVE_INFINITY;
  if (Number.isFinite(Number(market.geometry?.threshold))) return Number(market.geometry.threshold);
  if (Number.isFinite(Number(market.threshold))) return Number(market.threshold);
  return Number.POSITIVE_INFINITY;
}

function overviewLineLabel(market = {}, seriesTicker = '') {
  const formatLevel = (value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    const isCpi = String(seriesTicker).startsWith('KXCPI');
    const decimals = Math.abs(numeric % 1) > 0 ? 2 : 0;
    const formatted = numeric.toLocaleString('en-US', isCpi
      ? { minimumFractionDigits: 1, maximumFractionDigits: 1 }
      : { maximumFractionDigits: decimals });
    if (isCpi) return `${formatted}%`;
    if (String(seriesTicker).startsWith('KXWTI')) return `$${formatted}`;
    return formatted;
  };
  const geometry = market.geometry || {};
  if (geometry.kind === 'lower_tail') return `Below ${formatLevel(geometry.upperBound)}`;
  if (geometry.kind === 'upper_tail') return `Above ${formatLevel(geometry.lowerBound ?? geometry.threshold)}`;
  if (geometry.kind === 'bucket') {
    return `${formatLevel(geometry.lowerBound)}–${formatLevel(geometry.upperBound)}`;
  }
  const threshold = geometry.threshold ?? market.threshold;
  if (threshold != null && Number.isFinite(Number(threshold))) return `Above ${formatLevel(threshold)}`;
  return market.title || market.ticker || 'Line unavailable';
}

function overviewLinePayload(market, workbench) {
  return {
    ticker: market.ticker,
    label: overviewLineLabel(market, workbench.seriesTicker),
    sortValue: overviewLineSortValue(market),
    yesBid: market.yesBid,
    yesAsk: market.yesAsk,
    yesBidSize: market.yesBidSize,
    yesAskSize: market.yesAskSize,
    noBid: market.noBid,
    noAsk: market.noAsk,
    noBidSize: market.noBidSize,
    noAskSize: market.noAskSize,
    volume24h: market.volume24h,
    openInterest: market.openInterest,
  };
}

function overviewLinesFromWorkbench(workbench = {}) {
  return (workbench.markets || [])
    .filter((market) => market?.ticker)
    .sort((left, right) => {
      const levelDelta = overviewLineSortValue(left) - overviewLineSortValue(right);
      return Number.isFinite(levelDelta)
        ? levelDelta
        : String(left.title || left.ticker).localeCompare(String(right.title || right.ticker));
    })
    .map((market) => overviewLinePayload(market, workbench));
}

function cpiForecastReference(signalAvailability = null) {
  if (String(signalAvailability?.status || '').toLowerCase() !== 'available') return null;
  const scenarios = Array.isArray(signalAvailability?.details?.scenarios)
    ? signalAvailability.details.scenarios
    : [];
  const base = scenarios.find((scenario) => (
    String(scenario?.key || scenario?.label || '').toLowerCase().includes('base')
  ));
  const value = finiteNumber(base?.value);
  if (value == null) return null;
  return {
    status: 'available',
    kind: 'forecast',
    label: 'Hedgeye base case',
    value,
    source: signalAvailability.source || 'hedgeye_inflation_nowcast',
    asOf: signalAvailability.asOf || null,
  };
}

const FUTURES_MONTH_NUMBERS = Object.freeze({
  F: '01',
  G: '02',
  H: '03',
  J: '04',
  K: '05',
  M: '06',
  N: '07',
  Q: '08',
  U: '09',
  V: '10',
  X: '11',
  Z: '12',
});

const ICE_TO_IBKR_WTI_PRODUCTS = Object.freeze({
  WBS: Object.freeze({
    symbol: 'WTI',
    tradingClass: 'WTI',
    exchange: 'IPE',
  }),
});

function wtiIbkrInstrument(settlementMapping = {}) {
  const source = String(settlementMapping?.source?.name || '').trim().toUpperCase();
  const contract = String(settlementMapping?.frontMonthContract || '').trim().toUpperCase();
  const match = contract.match(/^([A-Z0-9]+)\s+(\d{2})([FGHJKMNQUVXZ])-ICE$/);
  const month = FUTURES_MONTH_NUMBERS[match?.[3]];
  const ibkrProduct = ICE_TO_IBKR_WTI_PRODUCTS[match?.[1]];
  if (
    settlementMapping?.status !== 'consistent_unverified' ||
    source !== 'ICE' ||
    !match ||
    !month ||
    !ibkrProduct
  ) return null;
  return {
    symbol: ibkrProduct.symbol,
    secType: 'FUT',
    exchange: ibkrProduct.exchange,
    currency: 'USD',
    provider: 'ibkr',
    lastTradeDateOrContractMonth: `20${match[2]}${month}`,
    tradingClass: ibkrProduct.tradingClass,
  };
}

async function wtiUnderlyingReference(workbench, deps, now = Date.now()) {
  const instrument = wtiIbkrInstrument(workbench?.settlementMapping);
  if (!instrument) {
    return {
      status: 'unavailable',
      kind: 'underlying',
      label: 'WTI',
      displayFormat: 'wti_contract',
      reason: 'The exact ICE WTI settlement contract could not be verified.',
    };
  }

  const unavailable = (reason) => ({
    status: 'unavailable',
    kind: 'underlying',
    label: 'WTI',
    displayFormat: 'wti_contract',
    reason,
  });

  try {
    const quote = await deps.getQuote(instrument);
    const availability = classifyQuoteAvailability(quote, { now });
    const value = finiteNumber(quote?.price);
    if (
      availability !== 'current' ||
      String(quote?.source || '').toLowerCase() !== 'ibkr' ||
      value == null ||
      value <= 0
    ) {
      throw new Error('live_wti_quote_unavailable');
    }
    return {
      status: 'available',
      kind: 'underlying',
      label: 'WTI',
      displayFormat: 'wti_contract',
      tone: 'spot',
      value,
      source: 'ibkr',
      asOf: quote.timestamp || null,
      availability,
      instrument: {
        symbol: instrument.symbol,
        exchange: instrument.exchange,
        contractMonth: instrument.lastTradeDateOrContractMonth,
      },
    };
  } catch {
    // Fall through to the exact contract's dated IBKR close. Never use a
    // generic CL=F/Yahoo quote or a disconnected quote cache here.
  }

  const expectedSessionDate = latestCompletedWtiSessionDate(now);
  try {
    const history = await deps.getHistoricalBars(instrument, '5d', '1d');
    const source = String(history?.source || '').toLowerCase();
    const bar = source === 'ibkr'
      ? (history?.bars || []).find((candidate) => (
        historicalBarDateKey(candidate?.date) === expectedSessionDate &&
        finiteNumber(candidate?.close) != null &&
        finiteNumber(candidate.close) > 0
      ))
      : null;
    if (bar) {
      return {
        status: 'available',
        kind: 'underlying',
        label: 'WTI last close',
        displayFormat: 'wti_contract',
        tone: 'close',
        session: 'closed',
        value: finiteNumber(bar.close),
        source: 'ibkr_historical_daily_close',
        asOf: expectedSessionDate,
        availability: 'historical',
        historicalOnly: true,
        instrument: {
          symbol: instrument.symbol,
          exchange: instrument.exchange,
          contractMonth: instrument.lastTradeDateOrContractMonth,
        },
      };
    }
  } catch {
    // Fail closed below.
  }

  return unavailable('The current or latest completed close for the exact ICE WTI settlement contract is unavailable.');
}

function newYorkSessionParts(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = NEW_YORK_SESSION_FORMATTER.formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const hour = Number(values.hour);
  const minute = Number(values.minute);
  if (!values.year || !values.month || !values.day || !Number.isFinite(hour) || !Number.isFinite(minute)) {
    return null;
  }
  return {
    dateKey: `${values.year}-${values.month}-${values.day}`,
    minutes: (hour * 60) + minute,
  };
}

function spxCashSessionState(now = Date.now()) {
  const parts = newYorkSessionParts(now);
  if (!parts || !isTradingDateKey(parts.dateKey)) return 'closed';
  return parts.minutes >= (9 * 60 + 30) && parts.minutes < (16 * 60)
    ? 'open'
    : 'closed';
}

function latestCompletedSpxSessionDate(now = Date.now()) {
  const parts = newYorkSessionParts(now);
  if (!parts) return null;
  if (isTradingDateKey(parts.dateKey) && parts.minutes >= (16 * 60)) {
    return parts.dateKey;
  }
  return previousTradingDateKey(parts.dateKey);
}

function latestCompletedWtiSessionDate(now = Date.now()) {
  const parts = newYorkSessionParts(now);
  if (!parts) return null;
  if (isTradingDateKey(parts.dateKey) && parts.minutes >= WTI_SETTLEMENT_CLOSE_MINUTES) {
    return parts.dateKey;
  }
  return previousTradingDateKey(parts.dateKey);
}

function historicalBarDateKey(value) {
  const raw = String(value || '').trim();
  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const dashed = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (dashed) return dashed[1];
  return newYorkSessionParts(value)?.dateKey || null;
}

function newYorkDateTimeTimestamp(year, month, day, hour = 0, minute = 0, second = 0) {
  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  if (!Number.isFinite(naiveUtc)) return null;
  const parts = NEW_YORK_TIMESTAMP_FORMATTER.formatToParts(new Date(naiveUtc));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const localAsUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second),
  );
  return Number.isFinite(localAsUtc) ? naiveUtc - (localAsUtc - naiveUtc) : null;
}

function historicalBarTimestamp(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number' || (typeof value === 'string'
    && /^\d+(?:\.\d+)?$/.test(value.trim())
    && !/^\d{8}$/.test(value.trim()))) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    return numeric < 100000000000 ? numeric * 1000 : numeric;
  }
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)) {
    const zoned = Date.parse(raw);
    if (Number.isFinite(zoned)) return zoned;
  }
  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (compact) {
    return newYorkDateTimeTimestamp(
      Number(compact[1]),
      Number(compact[2]),
      Number(compact[3]),
      Number(compact[4] || 0),
      Number(compact[5] || 0),
      Number(compact[6] || 0),
    );
  }
  const dashed = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (dashed) {
    return newYorkDateTimeTimestamp(
      Number(dashed[1]),
      Number(dashed[2]),
      Number(dashed[3]),
      Number(dashed[4] || 0),
      Number(dashed[5] || 0),
      Number(dashed[6] || 0),
    );
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeUnderlyingBars(bars = [], now = Date.now()) {
  return (Array.isArray(bars) ? bars : [])
    .map((bar) => {
      const timestamp = historicalBarTimestamp(bar?.date ?? bar?.timestamp ?? bar?.time);
      const value = finiteNumber(bar?.close ?? bar?.price ?? bar?.value);
      const high = finiteNumber(bar?.high);
      if (
        timestamp == null ||
        value == null ||
        value <= 0 ||
        timestamp > now + 60 * 60 * 1000
      ) return null;
      return {
        timestamp,
        value,
        ...(high != null && high > 0 ? { high } : {}),
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.timestamp - right.timestamp);
}

function underlyingSessionDates(points = [], count = MULTI_DAY_SESSION_COUNT) {
  const pointCountByDate = points.reduce((counts, point) => {
    const date = historicalBarDateKey(point.timestamp);
    if (date && isTradingDateKey(date)) counts.set(date, (counts.get(date) || 0) + 1);
    return counts;
  }, new Map());
  return [...pointCountByDate.entries()]
    .filter(([, pointCount]) => pointCount >= 2)
    .map(([date]) => date)
    .sort()
    .slice(-count);
}

function isVerifiedUnderlyingHistory(history) {
  const provenance = [
    history?.warning,
    history?.error,
    history?.provenance,
    history?.cacheStatus,
    history?.cacheState,
    history?.sourceStatus,
    history?.fromCache ? 'cached' : '',
    history?.cached ? 'cached' : '',
    history?.cachedOnly ? 'cached-only' : '',
    history?.cacheOnly ? 'cache-only' : '',
    history?.cacheHit ? 'cache-hit' : '',
  ].filter(Boolean).join(' ');
  return Boolean(
    String(history?.source || '').trim().toLowerCase() === 'ibkr'
    && Array.isArray(history?.bars)
    && history.bars.length > 0
    && !FORBIDDEN_UNDERLYING_HISTORY_PROVENANCE.test(provenance)
  );
}

function unavailableUnderlyingMultiDayChart(baseChart, reason, range = '5d') {
  return {
    ...baseChart,
    range,
    status: 'unavailable',
    availability: 'historical',
    points: [],
    references: [],
    rangeDates: [],
    dailyRanges: [],
    comparisonDate: null,
    comparisonRange: null,
    reason,
  };
}

async function getVerifiedUnderlyingHistory(
  deps,
  instrument,
  range,
  interval,
  maxAttempts = 1,
) {
  let lastResult = null;
  const attempts = Math.max(1, Number.isInteger(maxAttempts) ? maxAttempts : 1);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      lastResult = await deps.getHistoricalBars(instrument, range, interval);
    } catch (error) {
      lastResult = {
        source: null,
        bars: [],
        error: error?.message || 'Verified IBKR underlying price history is unavailable.',
      };
    }
    if (isVerifiedUnderlyingHistory(lastResult)) {
      return lastResult;
    }
    const historyError = String(lastResult?.error || '').toLowerCase();
    const terminalHistoryError = /(timed? out|timeout|not connected|connection|socket|disabled|unsupported)/.test(historyError);
    if (attempt + 1 < attempts && !terminalHistoryError) {
      await new Promise((resolve) => setTimeout(resolve, OVERVIEW_UNDERLYING_HISTORY_RETRY_DELAY_MS));
    }
    if (terminalHistoryError) break;
  }
  return lastResult || { source: null, bars: [] };
}

async function buildUnderlyingMultiDayChart(baseChart, deps, config = {}, instrument, now = Date.now()) {
  const configuredSessionCount = Number.isInteger(config.multiDaySessionCount) && config.multiDaySessionCount > 0
    ? config.multiDaySessionCount
    : MULTI_DAY_SESSION_COUNT;
  const chartRange = `${configuredSessionCount}d`;
  if (typeof deps.getRiskRangeHistory !== 'function') {
    return unavailableUnderlyingMultiDayChart(baseChart, 'Verified daily Risk Range history is unavailable.', chartRange);
  }

  try {
    const historyRange = config.multiDayHistoryRange || MULTI_DAY_HISTORY_RANGE;
    const historyInterval = config.multiDayHistoryInterval || OVERVIEW_UNDERLYING_CHART_INTERVAL;
    const sessionCount = configuredSessionCount;
    const history = await getVerifiedUnderlyingHistory(
      deps,
      instrument,
      historyRange,
      historyInterval,
      config.historyRetryAttempts,
    );
    if (!isVerifiedUnderlyingHistory(history)) {
      return unavailableUnderlyingMultiDayChart(baseChart, 'Verified IBKR multi-day price history is unavailable.', chartRange);
    }
    const normalizedPoints = normalizeUnderlyingBars(history.bars, now);
    const allPoints = typeof config.pointFilter === 'function'
      ? normalizedPoints.filter((point) => config.pointFilter(point, instrument, now))
      : normalizedPoints;
    const includeRiskRangeComparison = config.includeRiskRangeComparison === true;
    const availableSessionDates = underlyingSessionDates(
      allPoints,
      sessionCount + (includeRiskRangeComparison ? 1 : 0),
    );
    const sessionDates = availableSessionDates.slice(-sessionCount);
    if (sessionDates.length !== sessionCount) {
      return unavailableUnderlyingMultiDayChart(baseChart, `Verified IBKR history does not contain the last ${sessionCount} market sessions.`, chartRange);
    }
    const comparisonDate = includeRiskRangeComparison && availableSessionDates.length > sessionCount
      ? availableSessionDates[availableSessionDates.length - sessionCount - 1]
      : null;
    const points = allPoints.filter((point) => sessionDates.includes(historicalBarDateKey(point.timestamp)));
    const requestedRangeDates = comparisonDate ? [comparisonDate, ...sessionDates] : sessionDates;
    const riskRanges = await deps.getRiskRangeHistory({
      ticker: config.riskRangeTicker || instrument.symbol,
      dates: requestedRangeDates,
    });
    if (!riskRanges || !['available', 'unavailable'].includes(riskRanges.status)) {
      return unavailableUnderlyingMultiDayChart(
        baseChart,
        riskRanges?.reason || `Verified daily Risk Range history is unavailable for the last ${sessionCount} market sessions.`,
        chartRange,
      );
    }

    const rtaRange = config.riskRangeOverride?.status === 'available'
      ? config.riskRangeOverride
      : null;
    const todayKey = newYorkSessionParts(now)?.dateKey;
    const buildDailyRange = (date, dayPoints) => {
      const range = riskRanges.ranges?.[date];
      const rangeForDate = date === todayKey && rtaRange
        ? {
          lrr: rtaRange.low ?? rtaRange.lrr,
          hrr: rtaRange.high ?? rtaRange.hrr,
          source: rtaRange.source || 'Hedgeye Real-Time Alert',
          asOf: rtaRange.asOf || date,
        }
        : range;
      const lrr = finiteNumber(rangeForDate?.lrr);
      const hrr = finiteNumber(rangeForDate?.hrr);
      const startAt = dayPoints[0]?.timestamp || null;
      const endAt = dayPoints[dayPoints.length - 1]?.timestamp || startAt;
      if (dayPoints.length < 2 || lrr == null || hrr == null || lrr >= hrr) {
        return {
          date,
          startAt,
          endAt,
          status: 'unavailable',
          references: [],
          reason: `Exact-date Risk Range data is unavailable for ${date}.`,
        };
      }
      const source = rangeForDate?.source || riskRanges.source || 'RiskRangeData';
      const asOf = rangeForDate?.asOf || rangeForDate?.date || date;
      return {
        date,
        startAt,
        endAt,
        status: 'available',
        references: [
          {
            status: 'available',
            kind: 'underlying',
            label: 'LRR',
            tone: 'low',
            value: lrr,
            source,
            asOf,
          },
          {
            status: 'available',
            kind: 'underlying',
            label: 'HRR',
            tone: 'high',
            value: hrr,
            source,
            asOf,
          },
        ],
      };
    };
    const dailyRanges = sessionDates.map((date) => buildDailyRange(
      date,
      points.filter((point) => historicalBarDateKey(point.timestamp) === date),
    ));
    const comparisonPoints = comparisonDate
      ? allPoints.filter((point) => historicalBarDateKey(point.timestamp) === comparisonDate)
      : [];
    const comparisonRange = comparisonDate
      ? buildDailyRange(comparisonDate, comparisonPoints)
      : null;

    const latestPoint = points[points.length - 1];
    const sessionOpen = typeof config.isSessionOpen === 'function' ? config.isSessionOpen(now) : null;
    const availability = sessionOpen === true && sessionDates.includes(todayKey) ? 'current' : 'historical';
    const riskRangeMissingDates = dailyRanges
      .filter((range) => range.status !== 'available')
      .map((range) => range.date);
    return {
      ...baseChart,
      range: chartRange,
      interval: historyInterval,
      status: 'available',
      availability,
      fetchedAt: new Date(now).toISOString(),
      latestAt: latestPoint ? new Date(latestPoint.timestamp).toISOString() : null,
      points,
      references: [],
      rangeDates: sessionDates,
      dailyRanges,
      comparisonDate,
      comparisonRange,
      riskRangeStatus: riskRangeMissingDates.length > 0 ? 'partial' : 'available',
      riskRangeMissingDates,
      riskRangeReason: riskRanges.reason || null,
      reason: null,
    };
  } catch (error) {
    const label = config.label || instrument?.symbol || 'underlying';
    return unavailableUnderlyingMultiDayChart(
      baseChart,
      error?.message || `Verified multi-day ${label} history is unavailable.`,
      chartRange,
    );
  }
}

function spxUnderlyingInstrument() {
  return {
    symbol: 'SPX',
    secType: 'IND',
    exchange: 'CBOE',
    currency: 'USD',
    provider: 'ibkr',
  };
}

async function spxUnderlyingReference(deps, now = Date.now()) {
  const instrument = spxUnderlyingInstrument();
  if (spxCashSessionState(now) === 'open') {
    try {
      const quote = await deps.getQuote(instrument);
      const value = finiteNumber(quote?.price);
      const availability = classifyQuoteAvailability(quote, { now });
      if (
        availability === 'current' &&
        String(quote?.source || '').toLowerCase() === 'ibkr' &&
        value != null &&
        value > 0
      ) {
        return {
          status: 'available',
          kind: 'underlying',
          label: 'S&P 500',
          displayFormat: 'spx_contract',
          tone: 'spot',
          session: 'open',
          value,
          source: 'ibkr',
          asOf: quote.timestamp || null,
          availability,
        };
      }
    } catch {
      // Fail closed below.
    }
    return {
      status: 'unavailable',
      kind: 'underlying',
      label: 'S&P 500',
      displayFormat: 'spx_contract',
      session: 'open',
      reason: 'Verified-live S&P 500 spot is unavailable.',
    };
  }

  const expectedSessionDate = latestCompletedSpxSessionDate(now);
  try {
    const history = await deps.getHistoricalBars(instrument, '5d', '1d');
    const source = String(history?.source || '').toLowerCase();
    const bar = source === 'ibkr'
      ? (history?.bars || []).find((candidate) => (
        historicalBarDateKey(candidate?.date) === expectedSessionDate &&
        finiteNumber(candidate?.close) != null &&
        finiteNumber(candidate.close) > 0
      ))
      : null;
    if (bar) {
      return {
        status: 'available',
        kind: 'underlying',
        label: 'S&P 500',
        displayFormat: 'spx_contract',
        tone: 'close',
        session: 'closed',
        value: finiteNumber(bar.close),
        source: 'ibkr_historical_daily_close',
        asOf: expectedSessionDate,
        availability: 'historical',
      };
    }
  } catch {
    // Fail closed below.
  }
  return {
    status: 'unavailable',
    kind: 'underlying',
    label: 'S&P 500',
    displayFormat: 'spx_contract',
    session: 'closed',
    reason: 'The latest completed IBKR S&P 500 close is unavailable.',
  };
}

function candlePrice(candle = {}, key) {
  return finiteNumber(
    candle?.price?.[`${key}_dollars`] ??
    candle?.price?.[key],
  );
}

function normalizeOverviewCandles(candles = [], now = Date.now()) {
  return (candles || [])
    .map((candle) => {
      const timestamp = finiteNumber(candle?.end_period_ts);
      const close = candlePrice(candle, 'close');
      if (
        timestamp == null ||
        close == null ||
        close < 0 ||
        close > 1 ||
        timestamp * 1000 > now + 60 * 60 * 1000
      ) return null;
      return {
        timestamp: timestamp * 1000,
        close,
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.timestamp - right.timestamp);
}

function forecastReferenceRows(signalAvailability = null) {
  const scenarios = Array.isArray(signalAvailability?.details?.scenarios)
    ? signalAvailability.details.scenarios
    : [];
  return scenarios.map((scenario) => {
    const value = finiteNumber(scenario?.value);
    if (value == null) return null;
    const key = String(scenario?.key || scenario?.label || '').trim().toLowerCase();
    const tone = key === 'upside' || key === 'high'
      ? 'high'
      : key === 'downside' || key === 'low'
        ? 'low'
        : 'base';
    return {
      status: 'available',
      kind: 'forecast',
      label: tone === 'high' ? 'High' : tone === 'low' ? 'Low' : 'Base',
      tone,
      value,
      source: signalAvailability?.source || 'hedgeye_inflation_nowcast',
      asOf: signalAvailability?.asOf || null,
    };
  }).filter(Boolean);
}

function attachCpiForecastChart(summary, signalAvailability, consensus, now = Date.now()) {
  const references = forecastReferenceRows(signalAvailability);
  const consensusAvailable = consensus?.status === 'available' &&
    finiteNumber(consensus?.value) != null &&
    Array.isArray(consensus?.points) &&
    consensus.points.length > 0;
  const consensusReference = consensusAvailable
    ? {
      status: 'available',
      kind: 'forecast',
      label: 'Cleveland Fed nowcast',
      value: finiteNumber(consensus.value),
      source: consensus.source,
      asOf: consensus.asOf || null,
    }
    : null;
  const chart = {
    kind: 'forecast',
    status: consensusAvailable ? 'available' : 'unavailable',
    range: 'forecast',
    source: consensus?.source || 'cleveland_fed_inflation_nowcasting',
    sourceUrl: consensus?.sourceUrl || null,
    label: 'CPI YoY nowcast',
    period: consensus?.period || consensus?.sourceMonth || null,
    asOf: consensus?.asOf || null,
    unit: 'percent',
    references,
    consensus: consensusReference,
    points: consensusAvailable
      ? consensus.points.map((point) => ({
        timestamp: finiteNumber(point?.timestamp),
        value: finiteNumber(point?.value),
      })).filter((point) => point.timestamp != null && point.value != null)
      : [],
    reason: consensusAvailable
      ? null
      : consensus?.reason || 'No current Cleveland Fed CPI consensus nowcast is available.',
    fetchedAt: new Date(now).toISOString(),
  };
  return { ...summary, chart };
}

function underlyingRiskRangeReferences(summary = {}) {
  const signal = summary.signal || {};
  const details = signal.details || {};
  const lrr = finiteNumber(details.lrr);
  const hrr = finiteNumber(details.hrr);
  if (
    signal.status !== 'available' ||
    lrr == null ||
    hrr == null ||
    lrr >= hrr
  ) return [];

  const source = signal.source || 'RiskRangeData';
  const asOf = signal.asOf || details.date || null;
  return [
    {
      status: 'available',
      kind: 'underlying',
      label: 'LRR',
      tone: 'low',
      value: lrr,
      source,
      asOf,
    },
    {
      status: 'available',
      kind: 'underlying',
      label: 'HRR',
      tone: 'high',
      value: hrr,
      source,
      asOf,
    },
  ];
}

function applySpxRtaRiskRange(signalAvailability = null, refreshedRange = null) {
  const signal = signalAvailability || {
    name: 'SPX Risk Range',
    status: 'unavailable',
  };
  const details = signal.details || {};
  const low = finiteNumber(refreshedRange?.low ?? refreshedRange?.lrr);
  const high = finiteNumber(refreshedRange?.high ?? refreshedRange?.hrr);
  const refreshedDetails = {
    status: refreshedRange?.status || 'unavailable',
    source: refreshedRange?.source || 'Hedgeye Real-Time Alert',
    asOf: refreshedRange?.asOf || null,
    low,
    high,
    sourceMessageId: refreshedRange?.sourceMessageId || null,
    reason: refreshedRange?.reason || null,
  };

  if (
    refreshedRange?.status !== 'available' ||
    low == null ||
    high == null ||
    low >= high
  ) {
    return {
      ...signal,
      details: {
        ...details,
        refreshedRiskRange: refreshedDetails,
      },
    };
  }

  const baselineLow = finiteNumber(details.lrr);
  const baselineHigh = finiteNumber(details.hrr);
  const baselineRiskRange = baselineLow != null && baselineHigh != null && baselineLow < baselineHigh
    ? {
      lrr: baselineLow,
      hrr: baselineHigh,
      source: signal.source || 'RiskRangeData',
      asOf: signal.asOf || details.date || null,
    }
    : null;
  const refreshedDate = newYorkSessionParts(refreshedRange.asOf)?.dateKey || details.date || null;
  return {
    ...signal,
    name: 'SPX Risk Range',
    status: 'available',
    asOf: refreshedRange.asOf || signal.asOf || null,
    source: 'Hedgeye Real-Time Alert',
    reason: null,
    details: {
      ...details,
      ticker: 'SPX',
      date: refreshedDate,
      lrr: low,
      hrr: high,
      match: 'rta_refreshed',
      baselineRiskRange,
      refreshedRiskRange: refreshedDetails,
    },
  };
}

async function attachUnderlyingOverviewChart(summary, deps, config = {}, now = Date.now()) {
  const instrument = config.instrument || null;
  const references = underlyingRiskRangeReferences(summary);
  const baseChart = {
    kind: 'underlying',
    range: '24h',
    source: 'ibkr_historical_bars',
    ticker: instrument?.symbol || null,
    label: config.label || instrument?.symbol || 'Underlying price',
    unit: config.unit || 'number',
    references,
    riskRangeSource: references[0]?.source || config.riskRangeOverride?.source || null,
    riskRangeAsOf: references[0]?.asOf || config.riskRangeOverride?.asOf || null,
    points: [],
  };
  const unavailable = (reason) => ({
    ...summary,
    chart: {
      ...baseChart,
      status: 'unavailable',
      reason,
    },
  });
  if (!instrument) return unavailable(config.missingInstrumentReason || 'The verified underlying instrument is unavailable.');

  try {
    const history = await getVerifiedUnderlyingHistory(
      deps,
      instrument,
      '1d',
      OVERVIEW_UNDERLYING_CHART_INTERVAL,
      config.historyRetryAttempts,
    );
    if (String(history?.source || '').toLowerCase() !== 'ibkr') {
      return unavailable('Verified IBKR underlying price history is unavailable.');
    }
    const points = normalizeUnderlyingBars(history.bars, now);
    const latestPoint = points[points.length - 1];
    if (!latestPoint || points.length < 2) {
      return unavailable('Verified IBKR underlying price history is unavailable.');
    }
    const age = now - latestPoint.timestamp;
    const current = age >= 0 && age <= OVERVIEW_CHART_MAX_AGE_MS;
    const expectedHistoricalDate = typeof config.historicalDateFor === 'function'
      ? config.historicalDateFor(now)
      : null;
    const latestDate = historicalBarDateKey(latestPoint.timestamp);
    const historical = !current && expectedHistoricalDate && latestDate === expectedHistoricalDate;
    if (!current && !historical) {
      return unavailable('No current or latest completed verified underlying price history is available.');
    }
    const sessionOpen = typeof config.isSessionOpen === 'function' ? config.isSessionOpen(now) : null;
    const sessionClosed = sessionOpen === false || sessionOpen === 'closed';
    const availability = historical || sessionClosed ? 'historical' : 'current';
    const oneDayChart = {
      ...baseChart,
      status: 'available',
      availability,
      fetchedAt: new Date(now).toISOString(),
      latestAt: new Date(latestPoint.timestamp).toISOString(),
      points,
    };
    if (config.enableMultiDayChart !== true) {
      return { ...summary, chart: oneDayChart };
    }
    const multiDayChart = await buildUnderlyingMultiDayChart(baseChart, deps, config, instrument, now);
    return {
      ...summary,
      chart: {
        ...oneDayChart,
        variants: {
          '1d': oneDayChart,
          '5d': multiDayChart,
        },
      },
    };
  } catch (error) {
    return unavailable(error?.message || 'Verified IBKR underlying price history is unavailable.');
  }
}

async function attachHistoricalOverviewChart(summary, deps) {
  const closeValue = finiteNumber(summary.settlementValue);
  const eventCloseMs = Date.parse(summary.closeTime);
  const chartLine = (summary.lines || [])
    .filter((line) => line?.ticker && finiteNumber(line.sortValue) != null)
    .sort((left, right) => {
      const leftDistance = closeValue == null ? Infinity : Math.abs(left.sortValue - closeValue);
      const rightDistance = closeValue == null ? Infinity : Math.abs(right.sortValue - closeValue);
      if (leftDistance !== rightDistance) return leftDistance - rightDistance;
      return (finiteNumber(right.volume24h) || 0) - (finiteNumber(left.volume24h) || 0);
    })[0] || null;
  const unavailable = (reason) => ({
    ...summary,
    chart: {
      status: 'unavailable',
      reason,
      range: '1d',
      source: 'kalshi_trade_api_v2',
      availability: 'historical',
      historicalOnly: true,
      ticker: chartLine?.ticker || null,
      label: chartLine?.label || null,
      points: [],
    },
  });
  if (!chartLine?.ticker || !summary.seriesTicker || !Number.isFinite(eventCloseMs)) {
    return unavailable('Settled contract price history is unavailable.');
  }

  try {
    const payload = await deps.kalshiFetch(
      `/series/${encodeURIComponent(summary.seriesTicker)}/markets/${encodeURIComponent(chartLine.ticker)}/candlesticks`,
      {
        start_ts: Math.floor((eventCloseMs - DAY_MS) / 1000),
        end_ts: Math.floor(eventCloseMs / 1000),
        period_interval: 60,
      },
    );
    const points = normalizeOverviewCandles(payload?.candlesticks, eventCloseMs);
    const latestAt = points[points.length - 1]?.timestamp || null;
    if (!latestAt) return unavailable('Settled contract price history is unavailable.');
    return {
      ...summary,
      chart: {
        status: 'available',
        range: '1d',
        source: 'kalshi_trade_api_v2',
        availability: 'historical',
        historicalOnly: true,
        ticker: chartLine.ticker,
        label: chartLine.label,
        fetchedAt: summary.freshness?.fetchedAt || null,
        latestAt: new Date(latestAt).toISOString(),
        points,
      },
    };
  } catch (error) {
    return unavailable(error?.message || 'Settled contract price history is unavailable.');
  }
}

function overviewSummaryFromWorkbench(
  workbench,
  signalName,
  signalAvailability = null,
  reference = null,
) {
  const market = highestVolumeCompleteMarket(workbench.markets || []);
  const referenceValue = reference?.status === 'available' ? finiteNumber(reference.value) : null;
  const lines = overviewLinesFromWorkbench(workbench);
  if (!market || !lines.length) {
    const error = new Error(`${workbench.seriesTicker || 'Prediction market'} has no complete direct venue book`);
    error.code = 'OVERVIEW_BOOK_UNAVAILABLE';
    throw error;
  }
  return {
    seriesTicker: workbench.seriesTicker,
    eventTicker: workbench.event?.ticker || market.eventTicker,
    eventTitle: workbench.event?.title || null,
    marketTicker: market.ticker,
    marketTitle: market.title || null,
    closeTime: workbench.event?.closeTime || market.closeTime || null,
    yesBid: market.yesBid,
    yesAsk: market.yesAsk,
    yesBidSize: market.yesBidSize,
    yesAskSize: market.yesAskSize,
    noBid: market.noBid ?? null,
    noAsk: market.noAsk ?? null,
    noBidSize: market.noBidSize ?? null,
    noAskSize: market.noAskSize ?? null,
    spread: market.spread ?? (
      market.yesBid != null && market.yesAsk != null
        ? Number((market.yesAsk - market.yesBid).toFixed(4))
        : null
    ),
    marketCount: workbench.event?.totalMarketCount ?? workbench.markets?.length ?? 0,
    completeBookCount: workbench.event?.completeBookCount ?? workbench.markets?.length ?? 0,
    volume24h: workbench.venue?.volume24h ?? 0,
    volumeTotal: workbench.venue?.volumeTotal ?? 0,
    openInterest: workbench.venue?.openInterest ?? 0,
    lines,
    lineCount: (workbench.markets || []).length,
    selection: {
      method: referenceValue == null ? 'market_implied_center' : 'reference_centered',
      label: referenceValue == null
        ? 'Centered on the 50¢ prediction line'
        : `Centered on ${reference.label}`,
    },
    reference: reference || {
      status: 'unavailable',
      reason: 'No verified reference is available.',
    },
    freshness: {
      status: 'direct_snapshot',
      fetchedAt: workbench.fetchedAt || null,
      updatedAt: workbench.venue?.updatedAt || market.updatedAt || null,
      snapshotType: workbench.venue?.snapshotType || 'direct_venue',
    },
    signal: {
      name: signalAvailability?.name || signalName,
      status: signalAvailability?.status || 'unavailable',
      requiredDate: signalAvailability?.requiredDate || null,
      requiredMonth: signalAvailability?.requiredMonth || null,
      asOf: signalAvailability?.asOf || null,
      source: signalAvailability?.source || null,
      reason: signalAvailability?.reason || null,
      details: signalAvailability?.details || null,
    },
    executable: false,
  };
}

function historicalSpxReference(session = {}) {
  const value = finiteNumber(session.closeValue);
  if (value == null) {
    return {
      status: 'unavailable',
      kind: 'underlying',
      label: 'Previous S&P 500 close',
      displayFormat: 'spx_contract',
      tone: 'close',
      historicalOnly: true,
      reason: 'The previous cash-SPX settlement value is unavailable.',
    };
  }
  return {
    status: 'available',
    kind: 'underlying',
    label: 'Previous S&P 500 close',
    displayFormat: 'spx_contract',
    tone: 'close',
    value,
    source: 'kalshi_settlement',
    asOf: session.settlementTime || session.event?.closeTime || null,
    availability: 'historical',
    historicalOnly: true,
  };
}

function overviewSummaryFromHistoricalSpxSession(session = {}, signalAvailability = null) {
  const markets = Array.isArray(session.markets) ? session.markets : [];
  const closeValue = finiteNumber(session.closeValue);
  const lines = markets
    .filter((market) => market?.ticker && finiteNumber(market.threshold) != null)
    .sort((left, right) => finiteNumber(left.threshold) - finiteNumber(right.threshold))
    .map((market) => {
      const threshold = finiteNumber(market.threshold);
      const formattedThreshold = threshold.toLocaleString('en-US', { maximumFractionDigits: 2 });
      return {
        ticker: market.ticker,
        label: `Above ${formattedThreshold}`,
        sortValue: threshold,
        settlementResult: String(market.result || '').toUpperCase() || '—',
        settlementValue: closeValue,
        volume24h: market.volume24h || 0,
        openInterest: market.openInterest || 0,
      };
    });
  if (!lines.length || closeValue == null) {
    const error = new Error('No verified previous cash-SPX contract is available');
    error.code = 'SPX_HISTORY_UNAVAILABLE';
    throw error;
  }
  const fetchedAt = session.fetchedAt || new Date().toISOString();
  return {
    seriesTicker: session.seriesTicker || SPX_CLOSE_SERIES_TICKER,
    eventTicker: session.event?.ticker || null,
    eventTitle: session.event?.title || 'Previous S&P 500 cash close',
    marketTicker: null,
    marketTitle: null,
    closeTime: session.event?.closeTime || null,
    settlementTime: session.event?.settlementTime || null,
    settlementValue: closeValue,
    historicalOnly: true,
    historicalLabel: 'Previous contract · settled',
    lines,
    lineCount: lines.length,
    selection: {
      method: 'historical_settled_contract',
      label: 'Previous contract · settled outcomes only',
    },
    reference: historicalSpxReference(session),
    freshness: {
      status: 'historical',
      fetchedAt,
      updatedAt: session.event?.settlementTime || session.event?.closeTime || null,
      snapshotType: 'settled_outcome',
    },
    signal: {
      name: signalAvailability?.name || 'SPX Risk Range',
      status: signalAvailability?.status || 'unavailable',
      requiredDate: signalAvailability?.requiredDate || null,
      requiredMonth: signalAvailability?.requiredMonth || null,
      asOf: signalAvailability?.asOf || null,
      source: signalAvailability?.source || null,
      reason: signalAvailability?.reason || null,
      details: signalAvailability?.details || null,
    },
    executable: false,
  };
}

function normalizeDirectOverviewMarket(market = {}) {
  const book = directBinaryBook(market);
  const tickerThreshold = String(market.ticker || '').match(/-T(-?\d+(?:\.\d+)?)$/i);
  return {
    ticker: market.ticker,
    eventTicker: market.event_ticker,
    title: market.title || market.subtitle || null,
    closeTime: market.close_time || null,
    threshold: finiteNumber(market.floor_strike) ?? finiteNumber(tickerThreshold?.[1]),
    cap: finiteNumber(market.cap_strike),
    strikeType: market.strike_type || null,
    yesBid: book.yesPricesDirect ? book.yesBid : null,
    yesAsk: book.yesPricesDirect ? book.yesAsk : null,
    yesBidSize: book.yesBidSize,
    yesAskSize: book.yesAskSize,
    noBid: book.noPricesDirect ? book.noBid : null,
    noAsk: book.noPricesDirect ? book.noAsk : null,
    noBidSize: book.noBidSize,
    noAskSize: book.noAskSize,
    spread: book.spread,
    nativeBook: {
      complete: book.completeBook,
      derivedFields: [],
    },
    volume24h: finiteNumber(market.volume_24h_fp ?? market.volume_24h) || 0,
    volumeTotal: finiteNumber(market.volume_fp ?? market.volume) || 0,
    openInterest: finiteNumber(market.open_interest_fp ?? market.open_interest) || 0,
    updatedAt: market.updated_time || null,
  };
}

function unavailableOverviewEntry(error, metadata = {}) {
  return {
    status: 'unavailable',
    summary: null,
    code: error?.code || 'MARKET_UNAVAILABLE',
    error: error?.message || 'Market snapshot unavailable',
    ...metadata,
  };
}

async function getPredictionMarketsOverview(options = {}) {
  const requestedMarketKeys = Array.isArray(options.marketKeys)
    ? new Set(options.marketKeys.map((key) => String(key)))
    : null;
  const includeMarket = (key) => !requestedMarketKeys || requestedMarketKeys.has(key);
  const deps = {
    kalshiFetch: options.kalshiFetch || kalshiFetch,
    checkGatewayHealth: options.checkGatewayHealth || checkGatewayHealth,
    getQuote: options.getQuote || ((instrument) => (
      require('../providers/compositeMarketDataProvider').getQuote(instrument)
    )),
    getHistoricalBars: options.getHistoricalBars || ((instrument, range, interval) => (
      require('../providers/compositeMarketDataProvider').getHistoricalBars(instrument, range, interval)
    )),
    getRiskRangeHistory: options.getRiskRangeHistory || null,
    getSpxRtaRiskRange: options.getSpxRtaRiskRange || (async () => ({
      status: 'unavailable',
      source: 'Hedgeye Real-Time Alert',
      reason: 'Real-Time Alert range provider is unavailable.',
    })),
    getSignalAvailability: options.getSignalAvailability || (async ({ market }) => ({
      name: market === 'cpi' ? 'Hedgeye Inflation Nowcast' : market === 'spx' ? 'SPX Risk Range' : 'WTIC Risk Range',
      status: 'unavailable',
      reason: 'Signal availability provider is unavailable.',
    })),
    getCpiConsensus: options.getCpiConsensus || ((context) => loadClevelandFedCpiNowcast(context)),
    now: options.now || Date.now,
  };
  const now = deps.now();
  const spxReferencePromise = includeMarket('spx') && spxCashSessionState(now) === 'open'
    ? spxUnderlyingReference(deps, now)
    : Promise.resolve(null);
  const spxRtaRiskRangePromise = includeMarket('spx')
    ? Promise.resolve()
      .then(() => deps.getSpxRtaRiskRange({ now }))
      .catch((error) => ({
        status: 'unavailable',
        source: 'Hedgeye Real-Time Alert',
        reason: error?.message || 'Real-Time Alert range provider is unavailable.',
      }))
    : Promise.resolve(null);
  const wtiReferences = {
    daily: null,
    weekly: null,
  };
  const signalFor = async (context) => {
    try {
      return await deps.getSignalAvailability(context);
    } catch (error) {
      return {
        name: context.market === 'cpi' ? 'Hedgeye Inflation Nowcast' : context.market === 'spx' ? 'SPX Risk Range' : 'WTIC Risk Range',
        status: 'unavailable',
        reason: error.message || 'Signal availability could not be verified.',
      };
    }
  };
  const cpiConfig = WATCHLIST_SERIES.find((config) => config.seriesTicker === 'KXCPIYOY');
  const tasks = {
    cpi: async () => {
      const result = await fetchSeriesRow(cpiConfig, deps, now);
      if (!result.row) {
        const error = new Error(result.warning || 'No open CPI contract is available');
        error.code = 'CPI_EVENT_UNAVAILABLE';
        throw error;
      }
      const markets = result.markets.map(normalizeDirectOverviewMarket);
      const workbench = {
        seriesTicker: cpiConfig.seriesTicker,
        fetchedAt: result.fetchedAt,
        event: {
          ticker: result.event?.event_ticker || result.row.eventTicker,
          title: result.event?.title || result.row.eventTitle,
          closeTime: result.row.closeTime,
          totalMarketCount: result.markets.length,
          completeBookCount: markets.filter((market) => market.nativeBook.complete).length,
        },
        markets,
        venue: {
          snapshotType: 'direct_venue',
          updatedAt: latestIso(markets.map((market) => market.updatedAt)),
          volume24h: sumHundredths(markets, 'volume24h'),
          volumeTotal: sumHundredths(markets, 'volumeTotal'),
          openInterest: sumHundredths(markets, 'openInterest'),
        },
      };
      const signal = await signalFor({ market: 'cpi', event: workbench.event, seriesTicker: workbench.seriesTicker });
      const summary = overviewSummaryFromWorkbench(
        workbench,
        cpiConfig.hedgeyeSignal,
        signal,
        cpiForecastReference(signal),
      );
      let consensus;
      try {
        consensus = await deps.getCpiConsensus({
          event: workbench.event,
          requiredMonth: signal?.requiredMonth || cpiMonthFromEvent(workbench.event),
          now,
        });
      } catch (error) {
        consensus = {
          status: 'unavailable',
          source: 'cleveland_fed_inflation_nowcasting',
          reason: error?.message || 'The Cleveland Fed CPI consensus nowcast is unavailable.',
        };
      }
      return attachCpiForecastChart(summary, signal, consensus, now);
    },
    spx: async () => {
      let workbench;
      try {
        workbench = await getSpxCloseWorkbench({
          kalshiFetch: deps.kalshiFetch,
          checkGatewayHealth: deps.checkGatewayHealth,
          now: deps.now,
        });
      } catch (error) {
        if (error?.code !== 'SPX_EVENT_UNAVAILABLE') throw error;
        const previous = await getLastSettledSpxCloseSession({
          kalshiFetch: deps.kalshiFetch,
          now: deps.now,
        });
        const baselineSignal = await signalFor({
          market: 'spx',
          seriesTicker: SPX_CLOSE_SERIES_TICKER,
        });
        const refreshedRange = await spxRtaRiskRangePromise;
        const signal = applySpxRtaRiskRange(baselineSignal, refreshedRange);
        const historicalSummary = overviewSummaryFromHistoricalSpxSession(previous, signal);
        const underlyingReference = await spxReferencePromise;
        const liveSummary = await attachUnderlyingOverviewChart({
          ...historicalSummary,
          reference: underlyingReference?.status === 'available'
            ? underlyingReference
            : historicalSummary.reference,
        }, deps, {
          instrument: spxUnderlyingInstrument(),
          label: 'S&P 500 index',
          unit: 'index',
          enableMultiDayChart: true,
          riskRangeTicker: 'SPX',
          riskRangeOverride: refreshedRange,
          historyRetryAttempts: SPX_UNDERLYING_HISTORY_MAX_ATTEMPTS,
          historicalDateFor: latestCompletedSpxSessionDate,
          isSessionOpen: spxCashSessionState,
        }, now);
        if (liveSummary?.chart?.status !== 'available') {
          const chartError = new Error(
            liveSummary?.chart?.reason || 'Verified current SPX underlying price history is unavailable.',
          );
          chartError.code = 'SPX_LIVE_CHART_UNAVAILABLE';
          throw chartError;
        }
        return liveSummary;
      }
      const baselineSignal = await signalFor({ market: 'spx', event: workbench.event, seriesTicker: workbench.seriesTicker });
      const refreshedRange = await spxRtaRiskRangePromise;
      const signal = applySpxRtaRiskRange(baselineSignal, refreshedRange);
      const summary = overviewSummaryFromWorkbench(
        {
          ...workbench,
          markets: workbench.overviewMarkets || workbench.markets,
        },
        'SPX Risk Range',
        signal,
        await spxReferencePromise,
      );
      return attachUnderlyingOverviewChart(summary, deps, {
        instrument: spxUnderlyingInstrument(),
        label: 'S&P 500 index',
        unit: 'index',
        enableMultiDayChart: true,
        riskRangeTicker: 'SPX',
        riskRangeOverride: refreshedRange,
        historyRetryAttempts: SPX_UNDERLYING_HISTORY_MAX_ATTEMPTS,
        historicalDateFor: latestCompletedSpxSessionDate,
        isSessionOpen: spxCashSessionState,
      }, now);
    },
    wtiDaily: async () => {
      const workbench = await getWtiWorkbench({
        cadence: 'daily',
        kalshiFetch: deps.kalshiFetch,
        checkGatewayHealth: deps.checkGatewayHealth,
        now: deps.now,
      });
      const reference = await wtiUnderlyingReference(workbench, deps, now);
      wtiReferences.daily = reference;
      const signal = await signalFor({ market: 'wti', cadence: 'daily', event: workbench.event, settlementMapping: workbench.settlementMapping, seriesTicker: workbench.seriesTicker });
      const summary = overviewSummaryFromWorkbench(
        workbench,
        'WTIC Risk Range',
        signal,
        reference,
      );
      return attachUnderlyingOverviewChart(summary, deps, {
        instrument: wtiIbkrInstrument(workbench.settlementMapping),
        label: 'WTI front-month price',
        unit: 'usd',
        enableMultiDayChart: true,
        riskRangeTicker: 'WTIC',
        historicalDateFor: latestCompletedWtiSessionDate,
      }, now);
    },
    wtiWeekly: async () => {
      const workbench = await getWtiWorkbench({
        cadence: 'weekly',
        kalshiFetch: deps.kalshiFetch,
        checkGatewayHealth: deps.checkGatewayHealth,
        now: deps.now,
      });
      const reference = await wtiUnderlyingReference(workbench, deps, now);
      wtiReferences.weekly = reference;
      const signal = await signalFor({ market: 'wti', cadence: 'weekly', event: workbench.event, settlementMapping: workbench.settlementMapping, seriesTicker: workbench.seriesTicker });
      const summary = overviewSummaryFromWorkbench(
        workbench,
        'WTIC Risk Range',
        signal,
        reference,
      );
      return attachUnderlyingOverviewChart(summary, deps, {
        instrument: wtiIbkrInstrument(workbench.settlementMapping),
        label: 'WTI front-month price',
        unit: 'usd',
        enableMultiDayChart: true,
        riskRangeTicker: 'WTIC',
        historicalDateFor: latestCompletedWtiSessionDate,
      }, now);
    },
  };
  const allKeys = Object.keys(tasks);
  const keys = allKeys.filter(includeMarket);
  // Give the SPX chart first access to the verified IBKR history provider.
  // The sidecar shares one IB socket, and starting the WTI history requests at
  // the same time can otherwise make the SPX response intermittently empty.
  const spxSettled = includeMarket('spx')
    ? await Promise.allSettled([tasks.spx()])
    : [];
  const remainingKeys = keys.filter((key) => key !== 'spx');
  const remainingSettled = await Promise.allSettled(remainingKeys.map((key) => tasks[key]()));
  const settledByKey = new Map([
    ...(includeMarket('spx') ? [['spx', spxSettled[0]]] : []),
    ...remainingKeys.map((key, index) => [key, remainingSettled[index]]),
  ]);
  const spxReference = await spxReferencePromise;
  const entries = Object.fromEntries(keys.map((key) => {
    const result = settledByKey.get(key);
    const unavailableMetadata = key === 'spx'
      ? { reference: spxReference }
      : key === 'wtiDaily'
        ? { reference: wtiReferences.daily }
        : key === 'wtiWeekly'
          ? { reference: wtiReferences.weekly }
          : {};
    return [key, result.status === 'fulfilled'
      ? { status: 'available', summary: result.value }
      : unavailableOverviewEntry(result.reason, unavailableMetadata)];
  }));
  const markets = {};
  if (includeMarket('cpi')) markets.cpi = entries.cpi;
  if (includeMarket('spx')) markets.spx = entries.spx;
  if (includeMarket('wtiDaily') || includeMarket('wtiWeekly')) {
    markets.wti = {};
    if (includeMarket('wtiDaily')) markets.wti.daily = entries.wtiDaily;
    if (includeMarket('wtiWeekly')) markets.wti.weekly = entries.wtiWeekly;
  }
  return {
    ok: true,
    fetchedAt: new Date(deps.now()).toISOString(),
    markets,
    policy: {
      factualComparisonOnly: true,
      automaticRankingAvailable: false,
      executionVerified: false,
      directVenuePricesOnly: true,
    },
  };
}

function chooseRepresentativeMarket(markets = []) {
  return [...markets].sort((a, b) => {
    const aBook = marketBook(a);
    const bBook = marketBook(b);
    if (aBook.liveBook !== bBook.liveBook) return aBook.liveBook ? -1 : 1;
    if (aBook.directQuote !== bBook.directQuote) return aBook.directQuote ? -1 : 1;
    const aDistance = aBook.midpoint == null ? Infinity : Math.abs(aBook.midpoint - 0.5);
    const bDistance = bBook.midpoint == null ? Infinity : Math.abs(bBook.midpoint - 0.5);
    if (aDistance !== bDistance) return aDistance - bDistance;
    const aSpread = aBook.spread == null ? Infinity : aBook.spread;
    const bSpread = bBook.spread == null ? Infinity : bBook.spread;
    if (aSpread !== bSpread) return aSpread - bSpread;
    return (finiteNumber(b.volume_24h_fp ?? b.volume_24h) || 0) - (finiteNumber(a.volume_24h_fp ?? a.volume_24h) || 0);
  })[0] || null;
}

function latestIso(values = []) {
  return values.filter(Boolean).sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null;
}

function liquidityStatus({ volume24h, book }) {
  const twoSidedDepth = Math.min(book.yesBidSize || 0, book.yesAskSize || 0);
  if (book.directQuote && (volume24h >= 100 || twoSidedDepth >= 100)) return 'active';
  if (book.directQuote && (volume24h > 0 || twoSidedDepth > 0)) return 'developing';
  return 'thin';
}

function laneFor(config, liquidity) {
  if (liquidity === 'thin') return 'blocked';
  if (config.matchType === 'exact') return 'exact';
  if (config.matchType === 'calibration') return 'calibrating';
  return 'missing-signal';
}

function nearestEventMarkets(markets = [], now = Date.now()) {
  const active = markets.filter((market) => {
    const closeMs = Date.parse(market.close_time);
    return Number.isFinite(closeMs) && closeMs > now && market.status !== 'closed' && market.status !== 'settled';
  });
  const nearestClose = active.reduce((current, market) => {
    const closeMs = Date.parse(market.close_time);
    return current == null || closeMs < current ? closeMs : current;
  }, null);
  if (nearestClose == null) return [];
  const nearest = active.filter((market) => Date.parse(market.close_time) === nearestClose);
  const eventTicker = nearest[0]?.event_ticker;
  return eventTicker ? active.filter((market) => market.event_ticker === eventTicker) : nearest;
}

function normalizeEventResponse(data = {}) {
  return data.event || data;
}

function rowFromMarkets(config, markets, event = {}, fetchedAt) {
  const representative = chooseRepresentativeMarket(markets);
  if (!representative) return null;
  const book = marketBook(representative);
  const volume24h = sumField(markets, 'volume_24h_fp', 'volume_24h');
  const volumeTotal = sumField(markets, 'volume_fp', 'volume');
  const openInterest = sumField(markets, 'open_interest_fp', 'open_interest');
  const status = liquidityStatus({ volume24h, book });
  const settlementSource = event.settlement_sources?.[0] || null;

  return {
    id: representative.event_ticker || representative.ticker,
    seriesTicker: config.seriesTicker,
    eventTicker: representative.event_ticker,
    marketTicker: representative.ticker,
    label: config.label,
    assetClass: config.assetClass,
    hedgeyeSignal: config.hedgeyeSignal,
    matchType: config.matchType,
    matchLabel: config.matchLabel,
    matchReason: config.matchReason,
    cadence: config.cadence,
    occurrencesPerMonth: config.occurrencesPerMonth,
    researchPriority: config.researchPriority ?? 99,
    screeningLabel: config.screeningLabel || null,
    lane: laneFor(config, status),
    eventTitle: event.title || representative.event_title || config.label,
    marketTitle: representative.title || representative.subtitle || representative.ticker,
    closeTime: representative.close_time,
    settlementSource: settlementSource ? { name: settlementSource.name, url: settlementSource.url } : null,
    availableOnBrokers: typeof event.available_on_brokers === 'boolean' ? event.available_on_brokers : null,
    venue: {
      name: 'Kalshi',
      source: 'kalshi_trade_api_v2',
      snapshotType: 'direct_venue',
      liquidityStatus: status,
      marketCount: markets.length,
      yesBid: book.yesBid,
      yesAsk: book.yesAsk,
      yesBidSize: book.yesBidSize,
      yesAskSize: book.yesAskSize,
      noBid: book.noBid,
      noAsk: book.noAsk,
      noBidSize: book.noBidSize,
      noAskSize: book.noAskSize,
      spread: book.spread,
      noSpread: book.noSpread,
      volume24h,
      volumeTotal,
      openInterest,
      fetchedAt,
      updatedAt: latestIso(markets.map((market) => market.updated_time)),
    },
    ibkr: {
      verified: false,
      conId: null,
      quoteTimestamp: null,
      sourceApi: null,
      marketDataType: null,
      nativeQuoteSide: null,
      nativeBid: null,
      nativeAsk: null,
      nativeBidSize: null,
      nativeAskSize: null,
      dataQualityFlags: [],
    },
    executable: false,
  };
}

function ibkrEventText(event = {}) {
  return [
    event.api_raw_symbol,
    event.symbol,
    event.localSymbol,
    event.question,
    event.contract_title,
  ].filter(Boolean).join(' ').toUpperCase();
}

function ibkrQuoteTimestamp(event = {}) {
  return event.exchange_timestamp || event.quote_timestamp || event.market_data_timestamp || event.updated_at || null;
}

function isStrictLiveIbkrEvent(event = {}, now = Date.now()) {
  const flags = [...(event.data_quality_flags || []), ...(event.flags || [])];
  const forbidden = ['stale_quote', 'portfolio_seed', 'portfolio_discovered', 'catalog_missing', 'mock', 'fallback', 'cache', 'cached', 'no_live_quote', 'incomplete', 'failed'];
  if (flags.some((flag) => forbidden.includes(flag))) return false;
  if (event.from_cache === true || event.fromCache === true || event.mock === true || event.fallback === true) return false;
  if (event.source_api !== 'IBKR_TWS_API' || !Number.isInteger(Number(event.conId)) || Number(event.conId) <= 0) return false;
  const marketDataType = String(event.dataType ?? event.marketDataType ?? '').toLowerCase();
  if (!['1', 'live'].includes(marketDataType)) return false;
  const timestamp = ibkrQuoteTimestamp(event);
  const age = timestamp ? now - Date.parse(timestamp) : Infinity;
  if (!Number.isFinite(age) || age < 0 || age > IBKR_QUOTE_MAX_AGE_MS) return false;
  const bid = finiteNumber(event.native_bid ?? event.quote_native_bid);
  const ask = finiteNumber(event.native_ask ?? event.quote_native_ask);
  const bidSize = finiteNumber(event.native_bid_size ?? event.quote_native_bid_size);
  const askSize = finiteNumber(event.native_ask_size ?? event.quote_native_ask_size);
  return bid != null && ask != null && bid >= 0 && ask <= 1 && ask > bid && bidSize > 0 && askSize > 0;
}

function attachIbkrVerification(rows = [], events = [], now = Date.now()) {
  const verifiedEvents = events.filter((event) => isStrictLiveIbkrEvent(event, now));
  return rows.map((row) => {
    const marketTicker = String(row.marketTicker || '').toUpperCase();
    const match = marketTicker
      ? verifiedEvents.find((event) => ibkrEventText(event).includes(marketTicker))
      : null;
    if (!match) return row;
    return {
      ...row,
      ibkr: {
        verified: true,
        conId: match.conId,
        quoteTimestamp: ibkrQuoteTimestamp(match),
        nativeQuoteSide: match.native_quote_side || null,
        sourceApi: match.source_api || null,
        marketDataType: match.dataType ?? match.marketDataType ?? null,
        nativeBid: finiteNumber(match.native_bid ?? match.quote_native_bid),
        nativeAsk: finiteNumber(match.native_ask ?? match.quote_native_ask),
        nativeBidSize: finiteNumber(match.native_bid_size ?? match.quote_native_bid_size),
        nativeAskSize: finiteNumber(match.native_ask_size ?? match.quote_native_ask_size),
        dataQualityFlags: [...(match.data_quality_flags || []), ...(match.flags || [])],
      },
      executable: true,
    };
  });
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function fetchSeriesRow(config, deps, now) {
  const minCloseTs = Math.floor(now / 1000);
  const maxCloseTs = Math.floor((now + config.horizonDays * DAY_MS) / 1000);
  const data = await deps.kalshiFetch('/events', {
    series_ticker: config.seriesTicker,
    status: 'open',
    limit: 200,
    min_close_ts: minCloseTs,
    max_close_ts: maxCloseTs,
    with_nested_markets: true,
  });
  const events = (data.events || []).filter((event) => (
    !config.eventTickerSuffix || String(event.event_ticker || '').endsWith(config.eventTickerSuffix)
  ));
  const allMarkets = events.flatMap((event) => (
    (event.markets || []).map((market) => ({ ...market, event_ticker: market.event_ticker || event.event_ticker }))
  ));
  const markets = nearestEventMarkets(allMarkets, now);
  if (!markets.length) return { config, row: null, markets: [], event: null, warning: 'No open contract in the configured horizon' };
  const eventTicker = markets[0].event_ticker;
  const event = normalizeEventResponse(events.find((candidate) => candidate.event_ticker === eventTicker) || {});
  const fetchedAt = new Date(deps.now()).toISOString();
  return {
    config,
    row: rowFromMarkets(config, markets, event, fetchedAt),
    markets,
    event,
    fetchedAt,
    warning: null,
  };
}

async function getPredictionMarketWatchlist(options = {}) {
  const deps = {
    kalshiFetch: options.kalshiFetch || kalshiFetch,
    checkGatewayHealth: options.checkGatewayHealth || checkGatewayHealth,
    fetchIbkrSnapshot: options.fetchIbkrSnapshot || null,
    now: options.now || Date.now,
    wait: options.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
  const requestSpacingMs = options.requestSpacingMs ?? 300;
  const startedAt = deps.now();
  let kalshiSeriesRequestCount = 0;
  const loadSeries = async (config) => {
    try {
      let result;
      try {
        kalshiSeriesRequestCount += 1;
        result = await fetchSeriesRow(config, deps, startedAt);
      } catch (err) {
        if (err.code !== 'RATE_LIMIT') throw err;
        await deps.wait(1100);
        kalshiSeriesRequestCount += 1;
        result = await fetchSeriesRow(config, deps, startedAt);
      }
      await deps.wait(requestSpacingMs);
      return result;
    } catch (err) {
      await deps.wait(requestSpacingMs);
      return { config, row: null, warning: err.message };
    }
  };
  const [initialSeriesResults, ibkrResult] = await Promise.all([
    mapLimit(WATCHLIST_SERIES, 1, loadSeries),
    (async () => {
      try {
        return deps.fetchIbkrSnapshot
          ? await deps.fetchIbkrSnapshot({
              forceRefresh: Boolean(options.forceRefresh),
              retryMissing: Boolean(options.retryMissing),
            })
          : await fetchCurrentIbkrPredictionSnapshot({
              checkGatewayHealth: deps.checkGatewayHealth,
              forceRefresh: Boolean(options.forceRefresh),
              retryMissing: Boolean(options.retryMissing),
            });
      } catch (error) {
        return {
          health: { ok: false, reason: 'error', message: error.message },
          release: null,
          events: [],
          provider: {
            status: 'error',
            errorCode: error.code || 'IBKR_PREDICTION_REFRESH_FAILED',
            message: error.message,
          },
        };
      }
    })(),
  ]);
  const seriesResults = [...initialSeriesResults];
  const initialVerifiedSeriesCount = initialSeriesResults.filter((result) => result.row).length;
  const retryIndexes = options.retryMissing
    ? initialSeriesResults
        .map((result, index) => (result.row ? null : index))
        .filter((index) => index != null)
    : [];
  if (retryIndexes.length) {
    const retryResults = await mapLimit(
      retryIndexes.map((index) => WATCHLIST_SERIES[index]),
      1,
      loadSeries,
    );
    retryIndexes.forEach((seriesIndex, retryIndex) => {
      seriesResults[seriesIndex] = retryResults[retryIndex];
    });
  }

  const venueRows = seriesResults.map((result) => result.row).filter(Boolean);
  if (!venueRows.length) {
    const error = new Error('Kalshi venue scan returned no current allowlisted contracts');
    error.code = 'VENUE_UNAVAILABLE';
    throw error;
  }

  const rows = attachIbkrVerification(venueRows, ibkrResult.events, deps.now())
    .sort((a, b) => {
      const laneOrder = { exact: 0, calibrating: 1, 'missing-signal': 2, blocked: 3 };
      const laneDelta = laneOrder[a.lane] - laneOrder[b.lane];
      if (laneDelta) return laneDelta;
      const priorityDelta = a.researchPriority - b.researchPriority;
      if (priorityDelta) return priorityDelta;
      return (b.venue.volume24h || b.venue.volumeTotal) - (a.venue.volume24h || a.venue.volumeTotal);
    });
  const warnings = seriesResults
    .filter((result) => result.warning)
    .map((result) => ({ seriesTicker: result.config.seriesTicker, message: result.warning }));
  const ibkrProvider = ibkrResult.provider || {};
  if (ibkrProvider.status && ibkrProvider.status !== 'connected') {
    warnings.push({
      seriesTicker: 'IBKR',
      code: ibkrProvider.errorCode || null,
      message: ibkrProvider.message || `IBKR prediction contracts unavailable (${ibkrProvider.status})`,
    });
  }
  const verifiedCount = rows.filter((row) => row.executable).length;
  const ibkrStatus = !ibkrResult.health?.ok
    ? (ibkrResult.health?.reason || ibkrProvider.status || 'offline')
    : (ibkrProvider.status && ibkrProvider.status !== 'connected'
      ? ibkrProvider.status
      : (verifiedCount ? 'verified_contracts' : 'connected_no_verified_contracts'));
  const missingSeriesTickers = seriesResults
    .filter((result) => !result.row)
    .map((result) => result.config.seriesTicker);
  const recoveredSeriesCount = retryIndexes.filter((index) => seriesResults[index].row).length;
  const completedAt = new Date(deps.now()).toISOString();
  const kalshiRefreshEvidence = {
    requestedSeriesCount: WATCHLIST_SERIES.length,
    initialVerifiedSeriesCount,
    venueRequestCount: kalshiSeriesRequestCount,
    retryCount: retryIndexes.length,
    recoveredSeriesCount,
    verifiedSeriesCount: venueRows.length,
    missingSeriesCount: missingSeriesTickers.length,
    missingSeriesTickers,
    coverageComplete: missingSeriesTickers.length === 0,
    fromCache: false,
  };
  const ibkrRefreshEvidence = ibkrProvider.refreshEvidence || {
    requestedContractCount: 0,
    brokerSnapshotRequestedCount: 0,
    brokerSnapshotRetryCount: 0,
    verifiedContractCount: verifiedCount,
    missingContractCount: null,
    missingContractCountKnown: false,
    coverageComplete: false,
    fromCache: false,
    blockedBy: ibkrProvider.errorCode || ibkrStatus,
  };
  const refreshEvidence = {
    mode: options.forceRefresh ? 'on_demand_prediction_fanout' : 'direct_prediction_refresh',
    requestedAt: new Date(startedAt).toISOString(),
    completedAt,
    fromCache: false,
    kalshi: kalshiRefreshEvidence,
    ibkr: ibkrRefreshEvidence,
  };

  return {
    ok: true,
    fetchedAt: completedAt,
    rows,
    warnings,
    refreshEvidence,
    providers: {
      kalshi: {
        status: 'direct_venue_snapshot',
        rowCount: rows.length,
        observedAt: rows.map((row) => row.venue?.fetchedAt).filter(Boolean).sort()[0] || null,
        refreshEvidence: kalshiRefreshEvidence,
      },
      ibkr: {
        status: ibkrStatus,
        connected: Boolean(ibkrResult.health?.ok),
        authenticated: Boolean(ibkrResult.health?.authenticated),
        verifiedContractCount: verifiedCount,
        errorCode: ibkrProvider.errorCode || ibkrResult.health?.errorCode || null,
        releaseKey: ibkrResult.release?.releaseKey || ibkrProvider.releaseKey || null,
        observedAt: ibkrProvider.last_success_at || null,
        refreshEvidence: ibkrRefreshEvidence,
        message: ibkrProvider.message || (ibkrResult.health?.ok
          ? (verifiedCount ? `${verifiedCount} current contracts passed strict quote verification` : 'Gateway connected; no current contract has a fresh native live quote and conId')
          : (ibkrResult.health?.message || 'Gateway unavailable')),
      },
    },
    policy: {
      venueRowsAreResearchOnly: true,
      executableRequires: 'IBKR conId + native marketDataType=live + direct bid/ask sizes + fresh exchange timestamp',
    },
  };
}

module.exports = {
  applySpxRtaRiskRange,
  WATCHLIST_SERIES,
  WTI_CADENCE_CONFIG,
  attachCpiForecastChart,
  attachHistoricalOverviewChart,
  attachIbkrVerification,
  attachUnderlyingOverviewChart,
  buildUnderlyingMultiDayChart,
  buildWtiSettlementMapping,
  chooseRepresentativeMarket,
  clampRecentSpxHistoryLimit,
  clampRecentWtiHistoryLimit,
  getLastSettledSpxCloseSession,
  getLastSettledWtiSession,
  getPredictionMarketsOverview,
  getPredictionMarketWatchlist,
  getRecentSettledSpxCloseSessions,
  getRecentSettledWtiSessions,
  getLastSettledSpxCloseQuoteSnapshot,
  getSpxCoverSnapshot,
  getSpxCloseWorkbench,
  getWtiWorkbench,
  historicalSpxReference,
  historicalBarDateKey,
  historicalBarTimestamp,
  isStrictLiveIbkrEvent,
  latestCompletedSpxSessionDate,
  latestCompletedWtiSessionDate,
  laneFor,
  listSettledSpxCloseEventMetadata,
  listSettledWtiEventMetadata,
  marketBook,
  nearestEventMarkets,
  normalizeSettledSpxCloseMarket,
  normalizeSettledWtiMarket,
  normalizeSpxCloseMarket,
  normalizeUnderlyingBars,
  overviewSummaryFromHistoricalSpxSession,
  normalizeWtiCadence,
  normalizeWtiGeometry,
  normalizeWtiMarket,
  rowFromMarkets,
  selectLastSettledSpxCloseEvent,
  selectSpxCloseEvent,
  selectWtiEvent,
  spxCashSessionState,
  spxCloseMarketBook,
  spxUnderlyingInstrument,
  spxUnderlyingReference,
  validateWtiGeometry,
  verifySettledSpxCloseEvent,
  verifySettledWtiEvent,
  wtiIbkrInstrument,
  wtiUnderlyingReference,
  wtiOutcomeForGeometry,
};
