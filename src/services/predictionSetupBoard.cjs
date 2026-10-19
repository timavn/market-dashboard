const UNIVERSE = require('../constants/predictionMarketUniverse.json');
const { canonicalTradeResearch } = require('../utils/canonicalTradeResearch.cjs');
const { PRODUCTS: MORNING_PRODUCTS, PROXY_TICKERS, buildMorningResearch } = require('./predictionMorningResearch.cjs');

// One row per tracked Kalshi market: Hedgeye Tick/Trade/Trend, the verified
// underlying price, its Risk Range position, and the rule-based setup. Line
// selection and sizing are intentionally not computed here yet.

const TICK_DIRECTION = { Buy: 'BULLISH', Short: 'BEARISH', Wait: 'NEUTRAL' };
const OPPOSITE = { BULLISH: 'BEARISH', BEARISH: 'BULLISH', NEUTRAL: 'NEUTRAL' };
const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

const finite = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const direction = (value) => {
  const text = String(value || '').toUpperCase();
  return ['BULLISH', 'BEARISH', 'NEUTRAL'].includes(text) ? text : null;
};

// Hedgeye emails print their send time ("10/15/2026 07:37 AM EDT"); imported
// publishedAt values are midnight placeholders. Mirrors daily_research_rollup.publication_time.
const PUB_LINE = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?:\s*([AP]M))?\s+(EDT|EST|ET|PDT|PST|PT|UTC|GMT)\b/i;
const ZONES = { ET: 'America/New_York', EDT: 'America/New_York', EST: 'America/New_York',
  PT: 'America/Los_Angeles', PDT: 'America/Los_Angeles', PST: 'America/Los_Angeles' };

function zonedInstant(parts, zone) {
  const wall = Date.UTC(...parts);
  if (!zone) return new Date(wall);
  // The zone's offset at that wall time, applied twice to settle across a DST edge.
  const offset = (at) => {
    const local = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
      .formatToParts(new Date(at)).map(({ type, value }) => [type, Number(value)]));
    return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second) - at;
  };
  const first = wall - offset(wall);
  return new Date(wall - offset(first));
}

/** The research email's own send time, or null when only a date is known. */
function emailPublishedAt(snapshot) {
  const line = String(snapshot?.article?.bodyText || '').match(PUB_LINE);
  if (line) {
    const [, month, day, year, clock, minute, meridiem, zone] = line;
    let hour = Number(clock);
    if (meridiem) hour = (hour % 12) + (meridiem.toUpperCase() === 'PM' ? 12 : 0);
    const instant = zonedInstant([Number(year), Number(month) - 1, Number(day), hour, Number(minute)],
      ZONES[zone.toUpperCase()]);
    return Number.isNaN(instant.getTime()) ? null : instant.toISOString();
  }
  for (const value of [snapshot?.article?.publishedAt, snapshot?.publishedAt]) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && new Date(parsed).toISOString().slice(11, 19) !== '00:00:00') return value;
  }
  return null;
}

function riskRangeReading(market, { riskRanges, cryptoQuant }) {
  const spec = market.hedgeye.riskRange;
  if (!spec) return null;
  if (spec.product === 'crypto-quant') {
    const slot = cryptoQuant?.data?.cryptos?.[spec.ticker];
    const low = finite(slot?.buyTrade);
    const high = finite(slot?.sellTrade);
    if (low === null || high === null || low >= high) return null;
    return { low, high, trend: direction(slot.trend), ticker: spec.ticker, product: 'crypto-quant',
      date: cryptoQuant.date || null, fit: spec.fit };
  }
  const row = riskRanges?.ranges?.[spec.ticker];
  const low = finite(row?.lrr);
  const high = finite(row?.hrr);
  if (!row || low === null || high === null || low >= high) return null;
  return { low, high, trend: direction(row.trend), ticker: spec.ticker, product: 'risk-ranges',
    date: row.date || riskRanges?.manifest?.publicationDate || null, fit: spec.fit };
}

function tickReading(market, hedgai) {
  const spec = market.hedgeye.tick;
  if (!spec) return null;
  const row = hedgai?.book?.rows?.find((item) => String(item.ticker).toUpperCase() === spec.ticker);
  if (!row || !TICK_DIRECTION[row.position]) return null;
  const raw = TICK_DIRECTION[row.position];
  return {
    position: row.position, ticker: spec.ticker, inverse: spec.inverse === true, fit: spec.fit,
    // Price-ETF signals (SHY, UST) move opposite to the yield the market settles on.
    direction: spec.inverse === true ? OPPOSITE[raw] : raw,
    date: row.publicationDate || null, status: row.status || null,
  };
}

function tradeReading(market, securityIntelligence, marketDate) {
  const ticker = market.hedgeye.trade?.ticker;
  if (!ticker || !securityIntelligence) return null;
  const trade = canonicalTradeResearch(securityIntelligence, ticker, { date: marketDate });
  if (trade.status !== 'available') return null;
  return { direction: trade.direction, ticker: trade.ticker, date: trade.sourceDate,
    source: trade.sourceLabel || trade.source, sourceUrl: trade.sourceUrl };
}

function priceReading(symbol, label, fit, quotes) {
  const quote = quotes?.[symbol];
  const value = finite(quote?.price);
  if (value === null) return null;
  return { value, symbol, label, fit, asOf: quote.timestamp || quote.asOf || null, source: quote.source || null };
}

/** Section volatility gauge from the dashboard's verified volatility snapshot or quotes. */
function volatilityReading(market, { volatility, quotes, riskRanges }) {
  const spec = market.volatility;
  if (!spec) return null;
  let value = null;
  let changePct = null;
  let d15 = null;
  let m1 = null;
  let asOf = null;
  // A configured gauge without a usable reading still holds its row, shown as unavailable.
  const unavailable = { symbol: spec.symbol, label: spec.label, value: null, regimeKey: spec.regimeKey || null, unavailable: true };
  if (spec.source === 'volatility-snapshot') {
    const row = volatility?.[spec.key];
    // Verified session closes ("historical") and last-verified display readings ("reference",
    // e.g. MOVE while its refresh is delayed) stay visible with their own date.
    if (!['available', 'historical', 'reference'].includes(row?.availability)) return unavailable;
    value = finite(row.lastPx);
    changePct = finite(row.dayChangePct);
    d15 = finite(row.fifteenDayChangePct);
    m1 = finite(row.monthChangePct);
    asOf = row.asOf || null;
  } else {
    const quote = quotes?.[spec.key];
    value = finite(quote?.price);
    changePct = finite(quote?.changePercent);
    asOf = quote?.observedAt || quote?.timestamp || null;
  }
  if (value === null) return unavailable;
  const range = spec.riskRangeTicker ? riskRanges?.ranges?.[spec.riskRangeTicker] : null;
  return { symbol: spec.symbol, label: spec.label, value, changePct, d15, m1, asOf, regimeKey: spec.regimeKey || null,
    ...(range && finite(range.lrr) !== null && finite(range.hrr) !== null
      ? { low: finite(range.lrr), high: finite(range.hrr), trend: direction(range.trend), rangeDate: range.date || null } : {}) };
}

/** US Dollar Index level with its Hedgeye Trend, Risk Range and published Trade. */
function usdReading({ quotes, riskRanges, securityIntelligence, usdPeriods, hedgai, marketDate }) {
  const spec = UNIVERSE.usd;
  const quote = quotes?.[spec.symbol];
  const value = finite(quote?.price);
  const range = riskRanges?.ranges?.[spec.riskRangeTicker];
  const trade = securityIntelligence ? canonicalTradeResearch(securityIntelligence, spec.tradeTicker, { date: marketDate }) : null;
  if (value === null && !range) return null;
  return { label: spec.label, value, changePct: finite(quote?.changePercent),
    d15: finite(usdPeriods?.fifteenDayChangePct), m1: finite(usdPeriods?.monthChangePct),
    asOf: quote?.observedAt || quote?.timestamp || null,
    trend: direction(range?.trend), low: finite(range?.lrr), high: finite(range?.hrr), rangeDate: range?.date || null,
    trade: trade?.status === 'available' ? { direction: trade.direction, date: trade.sourceDate, source: trade.sourceLabel || null } : null,
    tick: tickReading({ hedgeye: { tick: { ticker: spec.tickTicker, fit: 'proxy' } } }, hedgai) };
}

/** Each market's rolling correlation with the US Dollar from the dashboard's USD correlation table. */
function usdCorrelationReading(market, usdCorrelations) {
  const row = market.usdCorrelationKey ? usdCorrelations?.correlations?.[market.usdCorrelationKey] : null;
  const d15 = finite(row?.['15D']);
  const d30 = finite(row?.['30D']);
  const d60 = finite(row?.['60D']);
  const d90 = finite(row?.['90D']);
  if (d15 === null && d30 === null && d60 === null && d90 === null) return null;
  return { key: market.usdCorrelationKey, d15, d30, d60, d90, calculationDate: usdCorrelations?.calculationDate || null };
}

/** Position of price within [low, high]: 0 = low end, 1 = high end. */
function rangePosition(price, range) {
  if (!price || !range) return null;
  return (price.value - range.low) / (range.high - range.low);
}

function evaluateSetup({ trend, tick, trade, position }, rule = UNIVERSE.setupRule) {
  if (position === null || position === undefined) return { side: null, reason: 'No comparable range position' };
  if (position < 0 || position > 1) return { side: null, reason: position < 0 ? 'Below range' : 'Above range' };
  const long = trend === 'BULLISH' && tick?.direction === 'BULLISH' && position <= rule.bottomThird;
  const short = trend === 'BEARISH' && tick?.direction === 'BEARISH' && position >= rule.topThird;
  const side = long ? 'LONG' : short ? 'SHORT' : null;
  if (!side) return { side: null, reason: null };
  // Trade blocks only when it is published and points the other way.
  if (trade?.direction === OPPOSITE[side === 'LONG' ? 'BULLISH' : 'BEARISH']) {
    return { side: null, reason: 'Blocked by Trade' };
  }
  return { side, reason: null };
}

function eventSortKey(ticker) {
  const match = String(ticker).match(/-(\d{2})([A-Z]{3})(\d{2})?(?:H?(\d{2})(\d{2})?)?/);
  if (!match || !MONTHS[match[2]]) return null;
  const [, year, month, day = '00', hour = '00', minute = '00'] = match;
  return `${year}${String(MONTHS[month]).padStart(2, '0')}${day}${hour}${minute}`;
}

const EVENT_FILTERS = {
  '5pm': (ticker) => /-\d{2}[A-Z]{3}\d{2}17$/.test(ticker),
  close: (ticker) => /H1600$/.test(ticker),
  daily: (ticker) => /-\d{2}[A-Z]{3}\d{4}$/.test(ticker),
  any: () => true,
};

function eventFilter(market) {
  if (['gold', 'silver', 'copper', 'bitcoin', 'ethereum'].includes(market.id)) return EVENT_FILTERS['5pm'];
  if (['sp500', 'nasdaq100'].includes(market.id)) return EVENT_FILTERS.close;
  if (market.id === 'wti') return EVENT_FILTERS.daily;
  return EVENT_FILTERS.any;
}

/** Earliest open event of each series that matches the market's selection rule. */
function selectEvents(market, eventsBySeries) {
  const series = Array.isArray(market.kalshi.series) ? market.kalshi.series : [market.kalshi.series];
  const accept = eventFilter(market);
  return series.map((name) => {
    const events = (eventsBySeries?.[name] || [])
      .filter((event) => event?.event_ticker && accept(event.event_ticker) && eventSortKey(event.event_ticker))
      .sort((left, right) => eventSortKey(left.event_ticker).localeCompare(eventSortKey(right.event_ticker)));
    const event = events[0];
    return event ? { series: name, eventTicker: event.event_ticker, title: event.title || null,
      subTitle: event.sub_title || null } : { series: name, eventTicker: null };
  });
}

function cpiForecast(nowcast, event, month = null) {
  const reportMonth = month || eventMonth(event?.eventTicker);
  const forecasts = nowcast?.data?.forecasts || [];
  const forecast = forecasts.find((row) => row?.reportMonth === reportMonth);
  const scenarios = forecast?.scenarios || {};
  const values = ['lower', 'base', 'upper'].map((key) => finite(scenarios[key]));
  if (!forecast || values.some((value) => value === null)) return { reportMonth, available: false };
  return { reportMonth, available: true, lower: values[0], base: values[1], upper: values[2],
    publishedAt: forecast.publishedAt || nowcast.publishedAt || null, nowcastReleaseDate: forecast.releaseDate || null };
}

const eventMonth = (ticker) => {
  const month = String(ticker || '').match(/-(\d{2})([A-Z]{3})$/);
  return month && MONTHS[month[2]] ? `20${month[1]}-${String(MONTHS[month[2]]).padStart(2, '0')}` : null;
};

/**
 * Every month in the latest nowcast that BLS has not released yet, plus any from the current Kalshi
 * release on, each with its Kalshi event when one is listed. Kalshi may not list the next print.
 */
function cpiForecasts(nowcast, currentEvent, eventsBySeries, asOf) {
  const listed = new Map((eventsBySeries?.KXCPIYOY || []).map((event) => [eventMonth(event?.event_ticker), event.event_ticker]));
  const firstMonth = eventMonth(currentEvent?.eventTicker);
  const now = Date.parse(asOf);
  const upcoming = (row) => {
    const release = Date.parse(row?.releaseAt || (row?.releaseDate && `${row.releaseDate}T23:59:59Z`));
    return Number.isFinite(release) && Number.isFinite(now) ? release > now : null;
  };
  const months = [...new Set((nowcast?.data?.forecasts || [])
    .filter((row) => /^\d{4}-\d{2}$/.test(String(row?.reportMonth || '')))
    .filter((row) => upcoming(row) ?? (!firstMonth || row.reportMonth >= firstMonth))
    .map((row) => row.reportMonth).concat(listed.has(firstMonth) ? [firstMonth] : []))].sort();
  return months.map((month) => ({ ...cpiForecast(nowcast, { eventTicker: listed.get(month) || null }, month),
    eventTicker: listed.get(month) || null }));
}

/**
 * What the market date's Hedgeye products say about each market, checked
 * against the live prices on this board. Saved boards without morning
 * products keep their original shape.
 */
// A product that prints no send time (Market Structure) shows when the dashboard read it.
const readAt = (snapshot) => emailPublishedAt(snapshot) || (Number.isFinite(Date.parse(snapshot?.scrapedAt)) ? snapshot.scrapedAt : null);

function morningResearch({ morningSnapshots, cryptoQuant, rows, usd, quotes, marketDate }) {
  if (!morningSnapshots) return null;
  const references = {};
  const prices = {};
  for (const row of rows) {
    const value = row.price?.value ?? (row.range ? (row.range.low + row.range.high) / 2 : null);
    if (Number.isFinite(value)) references[row.id] = value;
    if (Number.isFinite(row.price?.value)) prices[row.id] = row.price.value;
    if (row.id === 'nasdaq100' && Number.isFinite(row.rangePrice?.value)) references.compq = row.rangePrice.value;
  }
  if (Number.isFinite(usd?.value)) {
    references.usd = usd.value;
    prices.usd = usd.value;
  }
  for (const ticker of PROXY_TICKERS) {
    const value = finite(quotes?.[ticker]?.price);
    if (value !== null) references[ticker] = value;
  }
  const riskRangeTickers = Object.fromEntries(UNIVERSE.markets.filter((market) => market.hedgeye.riskRange?.product === 'risk-ranges')
    .map((market) => [market.hedgeye.riskRange.ticker, market.id]).concat([[UNIVERSE.usd.riskRangeTicker, 'usd']]));
  return buildMorningResearch({ snapshots: { ...morningSnapshots, 'crypto-quant': morningSnapshots['crypto-quant'] || cryptoQuant },
    marketDate, references, prices, riskRangeTickers, publishedAt: readAt });
}

function buildSetupBoard({ riskRanges, cryptoQuant, hedgai, securityIntelligence, nowcast, quotes, volatility, usdCorrelations,
  usdPeriods, eventsBySeries, morningSnapshots,
  marketDate, asOf = new Date().toISOString() } = {}) {
  const rows = UNIVERSE.markets.map((market) => {
    const events = selectEvents(market, eventsBySeries);
    if (market.id === 'cpi') {
      return { id: market.id, label: market.label, group: market.group, cadence: market.cadence,
        events, forecast: cpiForecast(nowcast, events[0]), forecasts: cpiForecasts(nowcast, events[0], eventsBySeries, asOf) };
    }
    const range = riskRangeReading(market, { riskRanges, cryptoQuant });
    const price = priceReading(market.price.symbol, market.price.label, market.price.fit, quotes);
    // Compare a range only with its own instrument (Nasdaq Composite range → Composite price).
    const rangePrice = market.hedgeye.riskRange?.priceSymbol
      ? priceReading(market.hedgeye.riskRange.priceSymbol, market.hedgeye.riskRange.priceLabel, 'exact', quotes)
      : price;
    // A price far from its own published range is a different instrument (e.g. a stock sharing the
    // ticker), never a reading to position: withhold it instead of reporting a nonsense location.
    const mismatch = rangePrice && range
      && (rangePrice.value < (range.low + range.high) / 4 || rangePrice.value > (range.low + range.high));
    const position = mismatch ? null : rangePosition(rangePrice, range);
    const tick = tickReading(market, hedgai);
    const trade = tradeReading(market, securityIntelligence, marketDate);
    const trend = range?.trend || null;
    return {
      id: market.id, label: market.label, group: market.group, cadence: market.cadence, events,
      price: mismatch && rangePrice === price ? null : price,
      rangePrice: rangePrice === price || mismatch ? null : rangePrice, range, position,
      ...(mismatch ? { priceRejected: { symbol: rangePrice.symbol, value: rangePrice.value } } : {}),
      volatility: volatilityReading(market, { volatility, quotes, riskRanges }),
      usdCorrelation: usdCorrelationReading(market, usdCorrelations),
      tick, trade, trend, setup: evaluateSetup({ trend, tick, trade, position }),
    };
  });
  const usd = usdReading({ quotes, riskRanges, securityIntelligence, usdPeriods, hedgai, marketDate });
  const research = morningResearch({ morningSnapshots, cryptoQuant, rows, usd, quotes, marketDate });
  if (research) {
    for (const row of rows) row.research = research.markets[row.id] || { findings: [] };
    if (usd) usd.research = research.markets.usd || { findings: [] };
  }
  return { version: 1, asOf, marketDate: marketDate || null, rule: UNIVERSE.setupRule, sizing: UNIVERSE.sizing,
    sections: UNIVERSE.sections,
    usd,
    ...(research ? { research: { version: research.version, marketDate: research.marketDate, products: research.products } } : {}),
    sources: {
      riskRanges: riskRanges?.publishedAt || riskRanges?.manifest?.publicationDate || null,
      cryptoQuant: emailPublishedAt(cryptoQuant) || cryptoQuant?.date || null,
      hedgai: hedgai?.asOf || null,
      inflationNowcast: nowcast?.publishedAt || nowcast?.date || null,
    },
    rows };
}

const seriesNames = () => [...new Set(UNIVERSE.markets.flatMap((market) =>
  Array.isArray(market.kalshi.series) ? market.kalshi.series : [market.kalshi.series]))];
// ETF prices check levels the research prints for a market's proxy (QQQ, GLD, SPY …).
const priceSymbols = () => [...new Set(UNIVERSE.markets.flatMap((market) =>
  [market.price?.symbol, market.hedgeye.riskRange?.priceSymbol]).concat(UNIVERSE.usd.symbol, PROXY_TICKERS).filter(Boolean))];
const tradeTickers = () => [...new Set(UNIVERSE.markets.map((market) => market.hedgeye.trade?.ticker)
  .concat(UNIVERSE.usd.tradeTicker).filter(Boolean))];

/** Load every input independently; one failed source leaves its cells empty. */
function createSetupBoardLoader({ loadRiskRanges, loadCryptoQuant, loadHedgai, loadSecurityIntelligence,
  loadNowcast, loadQuotes, loadVolatility, loadUsdCorrelations, loadPeriodReturns, loadKalshiEvents, loadMorningProducts, marketDateFor }) {
  return async function loadSetupBoard({ now = new Date() } = {}) {
    const marketDate = marketDateFor(now);
    const settle = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));
    const [riskRanges, cryptoQuant, hedgai, securityIntelligence, nowcast, quotes, volatility, usdCorrelations, usdPeriods,
      events, morning] = await Promise.all([
      settle(loadRiskRanges({ now })),
      settle(loadCryptoQuant()),
      settle(loadHedgai({ now })),
      settle(loadSecurityIntelligence({ symbols: tradeTickers(), now })),
      settle(loadNowcast()),
      settle(loadQuotes(priceSymbols())),
      settle(loadVolatility()),
      settle(loadUsdCorrelations()),
      settle(loadPeriodReturns ? loadPeriodReturns(UNIVERSE.usd.symbol) : Promise.resolve(null)),
      settle(Promise.all(seriesNames().map((name) => loadKalshiEvents(name)
        .then((list) => [name, list], () => [name, []])))),
      settle(loadMorningProducts
        ? loadMorningProducts({ marketDate, products: MORNING_PRODUCTS.map((product) => product.key).filter((key) => key !== 'crypto-quant') })
        : Promise.resolve(null)),
    ]);
    const board = buildSetupBoard({
      riskRanges: riskRanges.value, cryptoQuant: cryptoQuant.value, hedgai: hedgai.value,
      securityIntelligence: securityIntelligence.value, nowcast: nowcast.value, quotes: quotes.value,
      volatility: volatility.value, usdCorrelations: usdCorrelations.value, usdPeriods: usdPeriods.value,
      eventsBySeries: Object.fromEntries(events.value || []), marketDate, asOf: now.toISOString(),
      morningSnapshots: loadMorningProducts ? (morning.value || {}) : undefined,
    });
    board.sourceStatus = Object.fromEntries(Object.entries({ riskRanges, cryptoQuant, hedgai, securityIntelligence,
      nowcast, quotes, volatility, usdCorrelations, kalshi: events, ...(loadMorningProducts ? { morningResearch: morning } : {}) })
      .map(([key, result]) => [key, result.error ? 'failed' : 'ready']));
    return board;
  };
}

/** Cboe indices the dashboard snapshot does not carry but a market's gauge needs (e.g. VXSLV). */
const extraCboeSeries = () => UNIVERSE.markets.map((market) => market.volatility)
  .filter((spec) => spec?.cboeSymbol).map((spec) => ({ name: spec.key, symbol: spec.cboeSymbol }));

module.exports = { buildSetupBoard, extraCboeSeries, createSetupBoardLoader, emailPublishedAt, evaluateSetup, eventSortKey, selectEvents,
  priceSymbols, seriesNames, tradeTickers };
