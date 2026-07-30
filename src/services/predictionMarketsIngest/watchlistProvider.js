const { kalshiFetch } = require('./providers/kalshiClient');
const { checkGatewayHealth } = require('./providers/ibkrProvider');
const { sidecarRequest } = require('./providers/ibkrHttp');
const { classifyQuoteAvailability } = require('../providers/multiRegionQuoteIntegrity.cjs');

const DAY_MS = 24 * 60 * 60 * 1000;
const IBKR_QUOTE_MAX_AGE_MS = Number(process.env.PM_IBKR_QUOTE_MAX_AGE_MS || 60000);
const SPX_CLOSE_SERIES_TICKER = 'KXINXU';
const SPX_CLOSE_EVENT_SUFFIX = 'H1600';
const SPX_RECENT_SETTLED_DEFAULT_LIMIT = 13;
const SPX_RECENT_SETTLED_MAX_LIMIT = 15;
const SPX_SETTLED_EVENT_PATTERN = new RegExp(`^${SPX_CLOSE_SERIES_TICKER}-\\d{2}[A-Z]{3}\\d{2}${SPX_CLOSE_EVENT_SUFFIX}$`);
const WTI_RECENT_SETTLED_DEFAULT_LIMIT = 13;
const WTI_RECENT_SETTLED_MAX_LIMIT = 15;
const WTI_SETTLED_DETAIL_SCAN_MAX = 50;
const OVERVIEW_CHART_MAX_AGE_MS = 2 * 60 * 60 * 1000;
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
  const directQuote = yesBid != null && yesAsk != null && yesBid >= 0 && yesAsk > 0 && yesAsk <= 1 && yesAsk >= yesBid;
  return {
    yesBid,
    yesAsk,
    yesBidSize,
    yesAskSize,
    directQuote,
    midpoint: directQuote ? (yesBid + yesAsk) / 2 : null,
    spread: directQuote ? yesAsk - yesBid : null,
  };
}

function spxCloseMarketBook(market = {}) {
  const yes = marketBook(market);
  const noBid = marketPrice(market, 'no_bid_dollars', 'no_bid');
  const noAsk = marketPrice(market, 'no_ask_dollars', 'no_ask');
  const noDirectQuote = noBid != null && noAsk != null && noBid >= 0 && noAsk > 0 && noAsk <= 1 && noAsk >= noBid;
  const liveBook = Boolean(
    yes.directQuote &&
    yes.yesBidSize > 0 &&
    yes.yesAskSize > 0 &&
    noDirectQuote
  );
  return {
    ...yes,
    noBid,
    noAsk,
    noDirectQuote,
    liveBook,
  };
}

function normalizeSpxCloseMarket(market = {}) {
  const book = spxCloseMarketBook(market);
  const threshold = finiteNumber(market.floor_strike);
  if (!book.liveBook || threshold == null) return null;
  return {
    ticker: market.ticker,
    eventTicker: market.event_ticker,
    title: market.title,
    threshold,
    closeTime: market.close_time,
    expectedExpirationTime: market.expected_expiration_time || null,
    rulesPrimary: market.rules_primary || null,
    status: market.status,
    yesBid: book.yesBid,
    yesAsk: book.yesAsk,
    yesBidSize: book.yesBidSize,
    yesAskSize: book.yesAskSize,
    noBid: book.noBid,
    noAsk: book.noAsk,
    volume24h: finiteNumber(market.volume_24h_fp ?? market.volume_24h) || 0,
    volumeTotal: finiteNumber(market.volume_fp ?? market.volume) || 0,
    openInterest: finiteNumber(market.open_interest_fp ?? market.open_interest) || 0,
    updatedAt: market.updated_time || null,
  };
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

function selectSpxCloseEvent(events = [], now = Date.now()) {
  return (events || [])
    .filter((event) => (
      String(event?.event_ticker || '').startsWith(`${SPX_CLOSE_SERIES_TICKER}-`) &&
      String(event?.event_ticker || '').endsWith(SPX_CLOSE_EVENT_SUFFIX) &&
      event?.available_on_brokers === true
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
    .sort((a, b) => Date.parse(a.closeTime) - Date.parse(b.closeTime))[0] || null;
}

function selectLastSettledSpxCloseEvent(events = [], now = Date.now()) {
  return listSettledSpxCloseEventMetadata(events, now)[0] || null;
}

function listSettledSpxCloseEventMetadata(events = [], now = Date.now()) {
  return (events || [])
    .filter((event) => (
      SPX_SETTLED_EVENT_PATTERN.test(String(event?.event_ticker || '')) &&
      event?.available_on_brokers === true
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
  const selected = selectSpxCloseEvent(data.events || [], now);
  if (!selected) {
    const error = new Error('Today’s 4 p.m. cash-SPX contract has settled or the next event is not listed yet. The ladder will return when Kalshi lists the next broker-enabled KXINXU H1600 event.');
    error.code = 'SPX_EVENT_UNAVAILABLE';
    throw error;
  }
  const fetchedAt = new Date(deps.now()).toISOString();
  const markets = selected.markets
    .map(normalizeSpxCloseMarket)
    .filter(Boolean)
    .sort((a, b) => a.threshold - b.threshold);
  if (!markets.length) {
    const error = new Error('The current 4 p.m. cash-S&P event has no complete two-sided direct venue books');
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
      availableOnBrokers: true,
      totalMarketCount: selected.markets.length,
      quotedMarketCount: markets.length,
    },
    markets,
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
      reason: 'Hedgeye Risk Range is not yet calibrated into a closing-threshold probability model',
    },
  };
}

function verifySettledSpxCloseEvent(detailData = {}, metadata = {}, now = Date.now()) {
  const event = detailData.event || detailData;
  const eventTicker = String(event?.event_ticker || '');
  const metadataTicker = String(metadata?.event?.event_ticker || '');
  if (
    !SPX_SETTLED_EVENT_PATTERN.test(eventTicker) ||
    eventTicker !== metadataTicker ||
    metadata?.event?.available_on_brokers !== true ||
    event?.available_on_brokers === false
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

async function fetchSettledSpxCloseMetadata(deps, now, minimumCandidateCount) {
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
    const candidates = listSettledSpxCloseEventMetadata(events, now);
    const nextCursor = data.cursor || null;
    if (candidates.length >= minimumCandidateCount || !nextCursor || seenCursors.has(nextCursor)) {
      return candidates;
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  return listSettledSpxCloseEventMetadata(events, now);
}

async function fetchVerifiedSettledSpxCloseSessions(options = {}, requestedLimit = 1, detailSlack = 5) {
  const deps = {
    kalshiFetch: options.kalshiFetch || kalshiFetch,
    now: options.now || Date.now,
  };
  const now = deps.now();
  const scanCount = Math.min(SPX_RECENT_SETTLED_MAX_LIMIT + 5, requestedLimit + detailSlack);
  const metadataRows = await fetchSettledSpxCloseMetadata(deps, now, scanCount);
  const candidates = metadataRows.slice(0, scanCount);
  const verified = [];
  for (const metadata of candidates) {
    const detailData = await deps.kalshiFetch(`/events/${metadata.event.event_ticker}`, {
      with_nested_markets: true,
    });
    const session = verifySettledSpxCloseEvent(detailData, metadata, now);
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

const OVERVIEW_LINE_LIMIT = 7;

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
    const decimals = Math.abs(numeric % 1) > 0 ? 2 : 0;
    const formatted = numeric.toLocaleString('en-US', { maximumFractionDigits: decimals });
    if (String(seriesTicker).startsWith('KXCPI')) return `${formatted}%`;
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
    noBid: market.noBid,
    noAsk: market.noAsk,
    volume24h: market.volume24h,
    openInterest: market.openInterest,
  };
}

function overviewLinesFromWorkbench(workbench = {}, centerValue = null) {
  const verified = (workbench.markets || [])
    .filter((market) => {
      const yesBid = Number(market.yesBid);
      const yesAsk = Number(market.yesAsk);
      return Number.isFinite(yesBid) &&
        Number.isFinite(yesAsk) &&
        yesBid >= 0 &&
        yesAsk <= 1 &&
        yesAsk >= yesBid &&
        Number(market.yesBidSize) > 0 &&
        Number(market.yesAskSize) > 0 &&
        market.nativeBook?.complete !== false;
    })
    .sort((left, right) => {
      const levelDelta = overviewLineSortValue(left) - overviewLineSortValue(right);
      return Number.isFinite(levelDelta)
        ? levelDelta
        : String(left.title || left.ticker).localeCompare(String(right.title || right.ticker));
    });
  if (verified.length <= OVERVIEW_LINE_LIMIT) {
    return verified.map((market) => overviewLinePayload(market, workbench));
  }

  const centerIndex = verified.reduce((bestIndex, market, index) => {
    const currentDistance = centerValue == null
      ? Math.abs(Number(market.yesAsk) - 0.5)
      : Math.abs(overviewLineSortValue(market) - Number(centerValue));
    const bestDistance = centerValue == null
      ? Math.abs(Number(verified[bestIndex].yesAsk) - 0.5)
      : Math.abs(overviewLineSortValue(verified[bestIndex]) - Number(centerValue));
    if (currentDistance !== bestDistance) return currentDistance < bestDistance ? index : bestIndex;
    return (market.volume24h || 0) > (verified[bestIndex].volume24h || 0) ? index : bestIndex;
  }, 0);
  const start = Math.max(0, Math.min(
    verified.length - OVERVIEW_LINE_LIMIT,
    centerIndex - Math.floor(OVERVIEW_LINE_LIMIT / 2),
  ));
  return verified
    .slice(start, start + OVERVIEW_LINE_LIMIT)
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

async function liveUnderlyingReference(market, deps, now = Date.now()) {
  const config = market === 'spx'
    ? {
      label: 'S&P 500',
      instrument: { symbol: 'SPX', secType: 'IND', exchange: 'CBOE', currency: 'USD' },
    }
    : {
      label: 'WTI',
      instrument: {
        symbol: 'CL',
        secType: 'FUT',
        exchange: 'NYMEX',
        currency: 'USD',
        providerSymbol: 'CL=F',
      },
    };
  try {
    const quote = await deps.getQuote(config.instrument);
    const availability = classifyQuoteAvailability(quote, { now });
    if (availability !== 'current' || String(quote?.source || '').toLowerCase() !== 'ibkr') {
      return {
        status: 'unavailable',
        kind: 'underlying',
        label: config.label,
        reason: 'Verified-live underlying price is unavailable.',
      };
    }
    return {
      status: 'available',
      kind: 'underlying',
      label: config.label,
      value: Number(quote.price),
      source: 'ibkr',
      asOf: quote.timestamp || null,
      availability,
    };
  } catch {
    return {
      status: 'unavailable',
      kind: 'underlying',
      label: config.label,
      reason: 'Verified-live underlying price is unavailable.',
    };
  }
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

async function attachOverviewChart(summary, deps, now = Date.now()) {
  const chartLine = (summary.lines || []).reduce((best, line) => {
    if (!best) return line;
    return Math.abs(line.yesAsk - 0.5) < Math.abs(best.yesAsk - 0.5) ? line : best;
  }, null);
  const unavailable = (reason) => ({
    ...summary,
    chart: {
      status: 'unavailable',
      reason,
      range: '1d',
      source: 'kalshi_trade_api_v2',
      ticker: chartLine?.ticker || null,
      label: chartLine?.label || null,
      points: [],
    },
  });
  if (!chartLine?.ticker || !summary.seriesTicker) {
    return unavailable('No representative live contract is available for the 1-day chart.');
  }

  try {
    const payload = await deps.kalshiFetch(
      `/series/${encodeURIComponent(summary.seriesTicker)}/markets/${encodeURIComponent(chartLine.ticker)}/candlesticks`,
      {
        start_ts: Math.floor((now - DAY_MS) / 1000),
        end_ts: Math.floor(now / 1000),
        period_interval: 60,
      },
    );
    const points = normalizeOverviewCandles(payload?.candlesticks, now);
    const latestAt = points[points.length - 1]?.timestamp || null;
    if (!latestAt || now - latestAt > OVERVIEW_CHART_MAX_AGE_MS) {
      return unavailable('No current direct venue price history is available for this contract.');
    }
    return {
      ...summary,
      chart: {
        status: 'available',
        range: '1d',
        source: 'kalshi_trade_api_v2',
        ticker: chartLine.ticker,
        label: chartLine.label,
        fetchedAt: new Date(now).toISOString(),
        latestAt: new Date(latestAt).toISOString(),
        points,
      },
    };
  } catch (error) {
    return unavailable(error?.message || 'The direct venue 1-day chart is unavailable.');
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
  const lines = overviewLinesFromWorkbench(workbench, referenceValue);
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

function unavailableOverviewEntry(error) {
  return {
    status: 'unavailable',
    summary: null,
    code: error?.code || 'MARKET_UNAVAILABLE',
    error: error?.message || 'Market snapshot unavailable',
  };
}

async function getPredictionMarketsOverview(options = {}) {
  const deps = {
    kalshiFetch: options.kalshiFetch || kalshiFetch,
    checkGatewayHealth: options.checkGatewayHealth || checkGatewayHealth,
    getQuote: options.getQuote || ((instrument) => (
      require('../providers/compositeMarketDataProvider').getQuote(instrument)
    )),
    getSignalAvailability: options.getSignalAvailability || (async ({ market }) => ({
      name: market === 'cpi' ? 'Hedgeye Inflation Nowcast' : market === 'spx' ? 'SPX Risk Range' : 'WTIC Risk Range',
      status: 'unavailable',
      reason: 'Signal availability provider is unavailable.',
    })),
    now: options.now || Date.now,
  };
  const now = deps.now();
  const spxReferencePromise = liveUnderlyingReference('spx', deps, now);
  const wtiReferencePromise = liveUnderlyingReference('wti', deps, now);
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
      return attachOverviewChart(summary, deps, now);
    },
    spx: async () => {
      const workbench = await getSpxCloseWorkbench({
        kalshiFetch: deps.kalshiFetch,
        checkGatewayHealth: deps.checkGatewayHealth,
        now: deps.now,
      });
      const signal = await signalFor({ market: 'spx', event: workbench.event, seriesTicker: workbench.seriesTicker });
      const summary = overviewSummaryFromWorkbench(
        workbench,
        'SPX Risk Range',
        signal,
        await spxReferencePromise,
      );
      return attachOverviewChart(summary, deps, now);
    },
    wtiDaily: async () => {
      const workbench = await getWtiWorkbench({
        cadence: 'daily',
        kalshiFetch: deps.kalshiFetch,
        checkGatewayHealth: deps.checkGatewayHealth,
        now: deps.now,
      });
      const signal = await signalFor({ market: 'wti', cadence: 'daily', event: workbench.event, settlementMapping: workbench.settlementMapping, seriesTicker: workbench.seriesTicker });
      const summary = overviewSummaryFromWorkbench(
        workbench,
        'WTIC Risk Range',
        signal,
        await wtiReferencePromise,
      );
      return attachOverviewChart(summary, deps, now);
    },
    wtiWeekly: async () => {
      const workbench = await getWtiWorkbench({
        cadence: 'weekly',
        kalshiFetch: deps.kalshiFetch,
        checkGatewayHealth: deps.checkGatewayHealth,
        now: deps.now,
      });
      const signal = await signalFor({ market: 'wti', cadence: 'weekly', event: workbench.event, settlementMapping: workbench.settlementMapping, seriesTicker: workbench.seriesTicker });
      const summary = overviewSummaryFromWorkbench(
        workbench,
        'WTIC Risk Range',
        signal,
        await wtiReferencePromise,
      );
      return attachOverviewChart(summary, deps, now);
    },
  };
  const keys = Object.keys(tasks);
  const settled = await Promise.allSettled(keys.map((key) => tasks[key]()));
  const entries = Object.fromEntries(settled.map((result, index) => {
    const key = keys[index];
    return [key, result.status === 'fulfilled'
      ? { status: 'available', summary: result.value }
      : unavailableOverviewEntry(result.reason)];
  }));
  return {
    ok: true,
    fetchedAt: new Date(deps.now()).toISOString(),
    markets: {
      cpi: entries.cpi,
      spx: entries.spx,
      wti: {
        daily: entries.wtiDaily,
        weekly: entries.wtiWeekly,
      },
    },
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
      spread: book.spread,
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
  const forbidden = ['stale_quote', 'portfolio_seed', 'portfolio_discovered', 'catalog_missing', 'mock', 'fallback', 'no_live_quote'];
  if (flags.some((flag) => forbidden.includes(flag))) return false;
  if (event.source_api !== 'IBKR_TWS_API' || !event.conId) return false;
  const marketDataType = String(event.dataType ?? event.marketDataType ?? '').toLowerCase();
  if (!['1', 'live'].includes(marketDataType)) return false;
  const timestamp = ibkrQuoteTimestamp(event);
  const age = timestamp ? now - Date.parse(timestamp) : Infinity;
  if (!Number.isFinite(age) || age < 0 || age > IBKR_QUOTE_MAX_AGE_MS) return false;
  const bid = finiteNumber(event.native_bid ?? event.quote_native_bid);
  const ask = finiteNumber(event.native_ask ?? event.quote_native_ask);
  const bidSize = finiteNumber(event.native_bid_size ?? event.quote_native_bid_size);
  const askSize = finiteNumber(event.native_ask_size ?? event.quote_native_ask_size);
  return bid != null && ask != null && ask > bid && bidSize > 0 && askSize > 0;
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
    sidecarRequest: options.sidecarRequest || sidecarRequest,
    now: options.now || Date.now,
    wait: options.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
  const requestSpacingMs = options.requestSpacingMs ?? 300;
  const startedAt = deps.now();
  const [seriesResults, ibkrResult] = await Promise.all([
    mapLimit(WATCHLIST_SERIES, 1, async (config) => {
      try {
        let result;
        try {
          result = await fetchSeriesRow(config, deps, startedAt);
        } catch (err) {
          if (err.code !== 'RATE_LIMIT') throw err;
          await deps.wait(1100);
          result = await fetchSeriesRow(config, deps, startedAt);
        }
        await deps.wait(requestSpacingMs);
        return result;
      } catch (err) {
        await deps.wait(requestSpacingMs);
        return { config, row: null, warning: err.message };
      }
    }),
    (async () => {
      const health = await deps.checkGatewayHealth();
      if (!health.ok) return { health, events: [], error: null };
      try {
        // The watchlist can mark a row executable, so it must force a live
        // sidecar quote refresh. The retained /events snapshot is diagnostic
        // state only and is never an execution source.
        const refresh = await deps.sidecarRequest('/refresh', {
          method: 'POST',
          timeoutMs: 5000,
        });
        return { health, events: refresh.events || [], error: null };
      } catch (err) {
        return { health, events: [], error: err.message };
      }
    })(),
  ]);

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
  if (ibkrResult.error) warnings.push({ seriesTicker: 'IBKR', message: ibkrResult.error });
  const verifiedCount = rows.filter((row) => row.executable).length;

  return {
    ok: true,
    fetchedAt: new Date(deps.now()).toISOString(),
    rows,
    warnings,
    providers: {
      kalshi: {
        status: 'direct_venue_snapshot',
        rowCount: rows.length,
      },
      ibkr: {
        status: ibkrResult.health.ok ? (verifiedCount ? 'verified_contracts' : 'connected_no_verified_contracts') : (ibkrResult.health.reason || 'offline'),
        connected: Boolean(ibkrResult.health.ok),
        authenticated: Boolean(ibkrResult.health.authenticated),
        verifiedContractCount: verifiedCount,
        message: ibkrResult.health.ok
          ? (verifiedCount ? `${verifiedCount} current contracts passed strict quote verification` : 'Gateway connected; no current contract has a fresh native live quote and conId')
          : (ibkrResult.health.message || 'Gateway unavailable'),
      },
    },
    policy: {
      venueRowsAreResearchOnly: true,
      executableRequires: 'IBKR conId + native marketDataType=live + direct bid/ask sizes + fresh exchange timestamp',
    },
  };
}

module.exports = {
  WATCHLIST_SERIES,
  WTI_CADENCE_CONFIG,
  attachIbkrVerification,
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
  getSpxCloseWorkbench,
  getWtiWorkbench,
  isStrictLiveIbkrEvent,
  laneFor,
  listSettledSpxCloseEventMetadata,
  listSettledWtiEventMetadata,
  marketBook,
  nearestEventMarkets,
  normalizeSettledSpxCloseMarket,
  normalizeSettledWtiMarket,
  normalizeSpxCloseMarket,
  normalizeWtiCadence,
  normalizeWtiGeometry,
  normalizeWtiMarket,
  rowFromMarkets,
  selectLastSettledSpxCloseEvent,
  selectSpxCloseEvent,
  selectWtiEvent,
  spxCloseMarketBook,
  validateWtiGeometry,
  verifySettledSpxCloseEvent,
  verifySettledWtiEvent,
  wtiOutcomeForGeometry,
};
