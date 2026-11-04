const UNIVERSE = require('../constants/predictionMarketUniverse.json');
const { canonicalTradeResearch } = require('../utils/canonicalTradeResearch.cjs');
const { selectLatestPublishedTrade } = require('../utils/publishedResearchSignals.cjs');
const { PRODUCTS: MORNING_PRODUCTS, PROXY_TICKERS, buildMorningResearch } = require('./predictionMorningResearch.cjs');
const { emailPublishedAt } = require('../utils/researchPublicationTime.cjs');
const { brokenAlphaCodeLine } = require('./analyst/alphaCodeWatch.cjs');

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

function tradeReading(market, securityIntelligence, marketDate, publishedStatements) {
  const spec = market.hedgeye.trade;
  // Spot metals settle on their published spot reference, which no security shares.
  if (spec?.reference) {
    const reading = publishedStatements && selectLatestPublishedTrade(publishedStatements.references,
      { ticker: spec.reference, asOf: marketDate, reference: true });
    if (reading?.status !== 'available') return null;
    return { direction: reading.value, ticker: reading.sourceTicker, date: reading.date,
      source: reading.sourceLabel || reading.sourceProduct, sourceUrl: reading.sourceUrl,
      instrument: reading.sourceInstrument || null, reference: true };
  }
  const ticker = spec?.ticker;
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

// A published Trade or Trend whose Alpha Code line the price has crossed since reads
// Neutral until the price is back on its side. The call it replaced is kept beside it.
const easternDate = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
function alphaCodeBreaks(watch, symbol, { trade, trend, trendDate }) {
  if (!watch || !symbol) return { trade, trend };
  const alphaBreaks = {};
  const breakOf = (line, published) => ({ level: line.level, side: line.side, since: line.since, price: line.price, priceAt: line.priceAt,
    product: line.product || null, productLabel: line.productLabel || null, published });
  const tradeLine = trade && brokenAlphaCodeLine(watch, symbol, 'trade', { value: trade.direction, date: trade.date });
  if (tradeLine) {
    alphaBreaks.trade = breakOf(tradeLine, { value: trade.direction, date: trade.date || null, source: trade.source || null });
    trade = { ...trade, direction: 'NEUTRAL', date: easternDate(tradeLine.since), source: `Alpha Code ${tradeLine.level}` };
  }
  const trendLine = trend && brokenAlphaCodeLine(watch, symbol, 'trend', { value: trend, date: trendDate });
  if (trendLine) {
    alphaBreaks.trend = breakOf(trendLine, { value: trend, date: trendDate || null, source: 'Risk Ranges' });
    trend = 'NEUTRAL';
  }
  return { trade, trend, ...(Object.keys(alphaBreaks).length ? { alphaBreaks } : {}) };
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

// Higher highs and higher lows are counted over this many session-to-session comparisons.
const STRUCTURE_SESSIONS = 10;
const STEP = { 1: '+', '-1': '-', 0: '=' };

/**
 * Same-direction run ending at the latest value. An unchanged session neither
 * adds to nor ends a run: published ranges often repeat at their rounding.
 */
function structureLeg(values) {
  const steps = values.slice(1).map((value, index) => Math.sign(value - values[index]));
  let direction = 0;
  let run = 0;
  for (const step of [...steps].reverse()) {
    if (step === 0) continue;
    if (direction === 0) direction = step;
    if (step !== direction) break;
    run += 1;
  }
  return { steps: steps.map((step) => STEP[step]).join(''), direction, run };
}

/** Prior publications of a market's own range, oldest first, as { date, low, high }. */
function rangeHistory(market, { riskRangeHistory, cryptoQuantHistory }) {
  const spec = market.hedgeye.riskRange;
  if (spec?.product === 'crypto-quant') {
    return (cryptoQuantHistory || []).map((snapshot) => {
      const slot = snapshot?.data?.cryptos?.[spec.ticker];
      return { date: snapshot?.date, low: finite(slot?.buyTrade), high: finite(slot?.sellTrade) };
    });
  }
  return (riskRangeHistory || []).map((publication) => {
    const row = publication?.ranges?.[spec?.ticker];
    return { date: publication?.date, low: finite(row?.lrr), high: finite(row?.hrr) };
  });
}

/**
 * Today's Risk Range against its previous publications: consecutive higher/lower
 * highs and lows, and whether the range top clears the instrument's all-time high.
 */
function structureReading(range, history, allTimeHigh) {
  const today = String(range?.date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) return null;
  // One reading per earlier weekday publication (weekends are not traded); a malformed or inverted range is skipped.
  const prior = [...new Map((history || [])
    .map((item) => ({ ...item, date: String(item?.date || '').slice(0, 10) }))
    .filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item.date) && item.date < today
      && new Date(`${item.date}T12:00:00Z`).getUTCDay() % 6 !== 0
      && item.low !== null && item.high !== null && item.low < item.high)
    .map((item) => [item.date, item])).values()]
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(-STRUCTURE_SESSIONS);
  if (!prior.length) return null;
  const sessions = [...prior, { date: today, low: range.low, high: range.high }];
  const ath = finite(allTimeHigh?.value);
  return {
    sessions: sessions.length - 1,
    since: sessions[0].date,
    high: structureLeg(sessions.map((item) => item.high)),
    low: structureLeg(sessions.map((item) => item.low)),
    allTimeHigh: ath === null ? null : { value: ath, date: allTimeHigh.date || null, symbol: allTimeHigh.symbol || null,
      rangeTopAbove: range.high > ath },
  };
}

// The latest session's volume against the prior session and the sessions in the 15, 30 and 90 calendar
// days before it: about 10, 21 and 62 sessions, Hedgeye's 10-day, 1-month and 3-month averages.
const VOLUME_WINDOWS = { d15: 15, d30: 30, d90: 90 };

/** Volume of the latest completed session of the market's ETF; a session without a close is still trading. */
function volumeReading(symbol, bars) {
  const sessions = (bars || [])
    .filter((bar) => /^\d{4}-\d{2}-\d{2}$/.test(String(bar?.date || '')) && finite(bar.volume) > 0 && finite(bar.rawClose) !== null)
    .sort((left, right) => left.date.localeCompare(right.date));
  if (sessions.length < 2) return null;
  const latest = sessions.at(-1);
  const prior = sessions.at(-2);
  const versus = (volume) => (volume > 0 ? ((latest.volume / volume) - 1) * 100 : null);
  const windowed = Object.fromEntries(Object.entries(VOLUME_WINDOWS).map(([key, days]) => {
    const start = new Date(`${latest.date}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() - days);
    const window = sessions.slice(0, -1).filter((bar) => bar.date > start.toISOString().slice(0, 10));
    return [key, window.length ? versus(window.reduce((sum, bar) => sum + bar.volume, 0) / window.length) : null];
  }));
  return { symbol, date: latest.date, volume: latest.volume, d1: versus(prior.volume), ...windowed,
    changePct: ((latest.rawClose / prior.rawClose) - 1) * 100 };
}

const Z_SCORE_SESSIONS = 20;
const etDay = (value) => (Number.isFinite(Date.parse(value))
  ? new Date(value).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) : null);

/** How many standard deviations the price sits from its mean over the 20 daily closes before the quote's day. */
function zScoreReading(price, history) {
  if (!Number.isFinite(price?.value)) return null;
  const day = etDay(price.asOf);
  const closes = (history || [])
    .filter((bar) => /^\d{4}-\d{2}-\d{2}$/.test(String(bar?.date || '')) && finite(bar.close) !== null && (!day || bar.date < day))
    .sort((left, right) => left.date.localeCompare(right.date)).slice(-Z_SCORE_SESSIONS);
  if (closes.length < Z_SCORE_SESSIONS) return null;
  const mean = closes.reduce((sum, bar) => sum + bar.close, 0) / closes.length;
  const sd = Math.sqrt(closes.reduce((sum, bar) => sum + (bar.close - mean) ** 2, 0) / (closes.length - 1));
  if (!(sd > 0)) return null;
  return { value: (price.value - mean) / sd, sessions: closes.length, through: closes.at(-1).date };
}

/**
 * DV when the session's volume is below its 30-day (1-month) average, AV above it, read for the Trend's side.
 * A move against the Trend (a down day in a Bullish Trend, an up day in a Bearish one) on DV supports adding;
 * on AV it warns. A move with the Trend on AV confirms it; on DV it says nothing either way.
 * The direction is the day's move in what the Trend describes (a yield for bond ETFs).
 */
function volumeSignal(volume, trend) {
  if (!volume || volume.d30 === null) return null;
  const move = volume.d30 < 0 ? 'DV' : 'AV';
  const direction = volume.changePct > 0 ? 'up' : volume.changePct < 0 ? 'down' : null;
  const side = !direction || !['BULLISH', 'BEARISH'].includes(trend) ? null
    : (trend === 'BULLISH') === (direction === 'up') ? 'with' : 'against';
  const tone = side === 'against' ? (move === 'DV' ? 'supports' : 'warns') : side === 'with' && move === 'AV' ? 'confirms' : null;
  return { move, tone, direction, side };
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
  if (['gold', 'silver', 'copper', 'brent', 'bitcoin', 'ethereum'].includes(market.id)) return EVENT_FILTERS['5pm'];
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
function cpiForecasts(nowcast, currentEvent, eventsBySeries, asOf, cpiConsensus) {
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
  // Boards captured with the survey consensus carry it on every month, null until it is published.
  const consensus = (month) => (cpiConsensus
    ? { consensus: finite(cpiConsensus.releases?.find((row) => row?.reportMonth === month)?.consensus) } : {});
  return months.map((month) => ({ ...cpiForecast(nowcast, { eventTicker: listed.get(month) || null }, month),
    eventTicker: listed.get(month) || null, ...consensus(month) }));
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

// The instrument a market's range is drawn against, whose all-time high the range top is checked with.
const allTimeHighSymbol = (market) => market.hedgeye.riskRange?.priceSymbol || market.price?.symbol || null;

function buildSetupBoard({ riskRanges, cryptoQuant, hedgai, securityIntelligence, nowcast, quotes, volatility, usdCorrelations,
  usdPeriods, eventsBySeries, morningSnapshots, riskRangeHistory, cryptoQuantHistory, allTimeHighs, volumeHistory,
  priceHistory, cpiConsensus, publishedStatements, alphaCodeWatch, marketDate, asOf = new Date().toISOString() } = {}) {
  // Saved boards from before volume keep their original shape.
  // Bond ETFs (SHY, IEF, TLT) move opposite to the yield their Trend describes.
  const volumeFor = ({ symbol, inverse } = {}, trend) => {
    const reading = symbol ? volumeReading(symbol, volumeHistory[symbol]) : null;
    if (!reading) return null;
    const signal = volumeSignal({ ...reading, changePct: inverse ? -reading.changePct : reading.changePct }, trend);
    return { ...reading, ...(inverse ? { inverse: true } : {}), signal };
  };
  // Saved boards from before range history keep their original shape.
  const withStructure = Boolean(riskRangeHistory || cryptoQuantHistory);
  const structureFor = (market, range) => (withStructure && range ? structureReading(range,
    rangeHistory(market, { riskRangeHistory, cryptoQuantHistory }), allTimeHighs?.[allTimeHighSymbol(market)]) : null);
  const rows = UNIVERSE.markets.map((market) => {
    const events = selectEvents(market, eventsBySeries);
    if (market.id === 'cpi') {
      return { id: market.id, label: market.label, group: market.group, cadence: market.cadence,
        events, forecast: cpiForecast(nowcast, events[0]),
        forecasts: cpiForecasts(nowcast, events[0], eventsBySeries, asOf, cpiConsensus) };
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
    const broken = alphaCodeBreaks(alphaCodeWatch, market.price?.symbol, {
      trade: tradeReading(market, securityIntelligence, marketDate, publishedStatements), trend: range?.trend || null, trendDate: range?.date });
    const { trade, trend } = broken;
    return {
      id: market.id, label: market.label, group: market.group, cadence: market.cadence, events,
      price: mismatch && rangePrice === price ? null : price,
      rangePrice: rangePrice === price || mismatch ? null : rangePrice, range, position,
      ...(mismatch ? { priceRejected: { symbol: rangePrice.symbol, value: rangePrice.value } } : {}),
      volatility: volatilityReading(market, { volatility, quotes, riskRanges }),
      usdCorrelation: usdCorrelationReading(market, usdCorrelations),
      tick, trade, trend, setup: evaluateSetup({ trend, tick, trade, position }),
      ...(broken.alphaBreaks ? { alphaBreaks: broken.alphaBreaks } : {}),
      ...(withStructure ? { structure: structureFor(market, range) } : {}),
      ...(volumeHistory ? { volume: volumeFor(market.volume, trend) } : {}),
      // Saved boards from before price history keep their original shape.
      ...(priceHistory ? { zScore: zScoreReading(mismatch && rangePrice === price ? null : price, priceHistory[market.price.symbol]) } : {}),
    };
  });
  const usd = usdReading({ quotes, riskRanges, securityIntelligence, usdPeriods, hedgai, marketDate });
  if (usd) {
    const broken = alphaCodeBreaks(alphaCodeWatch, UNIVERSE.usd.symbol, { trade: usd.trade, trend: usd.trend, trendDate: usd.rangeDate });
    Object.assign(usd, { trade: broken.trade, trend: broken.trend }, broken.alphaBreaks ? { alphaBreaks: broken.alphaBreaks } : {});
  }
  if (usd && volumeHistory) usd.volume = volumeFor({ symbol: UNIVERSE.usd.volumeSymbol }, usd.trend);
  if (usd && priceHistory) usd.zScore = zScoreReading({ value: usd.value, asOf: usd.asOf }, priceHistory[UNIVERSE.usd.symbol]);
  if (usd && withStructure) {
    usd.structure = usd.low !== null && usd.high !== null
      ? structureFor({ hedgeye: { riskRange: { product: 'risk-ranges', ticker: UNIVERSE.usd.riskRangeTicker } }, price: UNIVERSE.usd },
        { low: usd.low, high: usd.high, date: usd.rangeDate || riskRanges?.manifest?.publicationDate || null })
      : null;
  }
  const research = morningResearch({ morningSnapshots, cryptoQuant, rows, usd, quotes, marketDate });
  if (research) {
    for (const row of rows) row.research = research.markets[row.id] || { findings: [] };
    if (usd) usd.research = research.markets.usd || { findings: [] };
  }
  return { version: 1, asOf, marketDate: marketDate || null, rule: UNIVERSE.setupRule, sizing: UNIVERSE.sizing,
    sections: UNIVERSE.sections, ...(withStructure ? { structureSessions: STRUCTURE_SESSIONS } : {}),
    ...(volumeHistory ? { volumeWindows: VOLUME_WINDOWS } : {}),
    usd,
    ...(research ? { research: { version: research.version, marketDate: research.marketDate, products: research.products } } : {}),
    sources: {
      riskRanges: riskRanges?.publishedAt || riskRanges?.manifest?.publicationDate || null,
      cryptoQuant: emailPublishedAt(cryptoQuant) || cryptoQuant?.date || null,
      hedgai: hedgai?.asOf || null,
      inflationNowcast: nowcast?.publishedAt || nowcast?.date || null,
      ...(cpiConsensus ? { cpiConsensus: cpiConsensus.observedAt || null } : {}),
    },
    rows };
}

const seriesNames = () => [...new Set(UNIVERSE.markets.flatMap((market) =>
  Array.isArray(market.kalshi.series) ? market.kalshi.series : [market.kalshi.series]))];
// ETF prices check levels the research prints for a market's proxy (QQQ, GLD, SPY …).
const priceSymbols = () => [...new Set(UNIVERSE.markets.flatMap((market) =>
  [market.price?.symbol, market.hedgeye.riskRange?.priceSymbol]).concat(UNIVERSE.usd.symbol, PROXY_TICKERS).filter(Boolean))];
const volumeSymbols = () => [...new Set(UNIVERSE.markets.map((market) => market.volume?.symbol)
  .concat(UNIVERSE.usd.volumeSymbol).filter(Boolean))];
const zScoreSymbols = () => [...new Set(UNIVERSE.markets.map((market) => market.price?.symbol)
  .concat(UNIVERSE.usd.symbol).filter(Boolean))];
const allTimeHighSymbols = () => [...new Set(UNIVERSE.markets.filter((market) => market.hedgeye.riskRange)
  .map(allTimeHighSymbol).concat(UNIVERSE.usd.symbol).filter(Boolean))];
const tradeTickers = () => [...new Set(UNIVERSE.markets.map((market) => market.hedgeye.trade?.ticker)
  .concat(UNIVERSE.usd.tradeTicker).filter(Boolean))];

/**
 * Load every input independently; one failed source leaves its cells empty. With a researchDate, only what an
 * earlier market day's morning research needs: that day's products, read against the current ranges and prices.
 */
function createSetupBoardLoader({ loadRiskRanges, loadCryptoQuant, loadHedgai, loadSecurityIntelligence,
  loadNowcast, loadQuotes, loadVolatility, loadUsdCorrelations, loadPeriodReturns, loadKalshiEvents, loadMorningProducts,
  loadRiskRangeHistory, loadCryptoQuantHistory, loadAllTimeHighs, loadVolumeHistory, loadPriceHistory, loadCpiConsensus,
  loadPublishedStatements, loadAlphaCodeWatch, marketDateFor }) {
  return async function loadSetupBoard({ now = new Date(), researchDate = null } = {}) {
    const marketDate = researchDate || marketDateFor(now);
    const settle = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));
    const full = (load) => (researchDate ? Promise.resolve(null) : Promise.resolve().then(load));
    const loadedRanges = settle(loadRiskRanges({ now }));
    const optional = (load, args) => (load && !researchDate ? settle(Promise.resolve().then(() => load(args))) : Promise.resolve(null));
    // An earlier day reads its own Crypto Quant; the current one would put today's call on that date.
    const products = MORNING_PRODUCTS.map((product) => product.key).filter((key) => researchDate || key !== 'crypto-quant');
    const [riskRanges, cryptoQuant, hedgai, securityIntelligence, nowcast, quotes, volatility, usdCorrelations, usdPeriods,
      events, morning, riskRangeHistory, cryptoQuantHistory, allTimeHighs, volumeHistory, priceHistory, cpiConsensus,
      publishedStatements] = await Promise.all([
      loadedRanges,
      settle(loadCryptoQuant()),
      settle(full(() => loadHedgai({ now }))),
      settle(full(() => loadSecurityIntelligence({ symbols: tradeTickers(), now }))),
      settle(full(() => loadNowcast())),
      settle(loadQuotes(priceSymbols())),
      settle(full(() => loadVolatility())),
      settle(full(() => loadUsdCorrelations())),
      settle(full(() => (loadPeriodReturns ? loadPeriodReturns(UNIVERSE.usd.symbol) : null))),
      settle(full(() => Promise.all(seriesNames().map((name) => loadKalshiEvents(name)
        .then((list) => [name, list], () => [name, []]))))),
      settle(loadMorningProducts ? loadMorningProducts({ marketDate, products }) : Promise.resolve(null)),
      // Earlier publications than the one on the board, oldest first.
      loadedRanges.then((ranges) => optional(loadRiskRangeHistory, { before: ranges.value?.manifest?.publicationDate || null,
        sessions: STRUCTURE_SESSIONS, now })),
      optional(loadCryptoQuantHistory, { sessions: STRUCTURE_SESSIONS + 1 }),
      optional(loadAllTimeHighs, allTimeHighSymbols()),
      optional(loadVolumeHistory, volumeSymbols()),
      optional(loadPriceHistory, zScoreSymbols()),
      optional(loadCpiConsensus),
      // The day's archived statements: spot-reference Trade for the metals.
      optional(loadPublishedStatements, { date: marketDate }),
    ]);
    if (researchDate && morning.value) morning.value = { 'crypto-quant': {}, ...morning.value };
    const board = buildSetupBoard({
      riskRanges: riskRanges.value, cryptoQuant: cryptoQuant.value, hedgai: hedgai.value,
      securityIntelligence: securityIntelligence.value, nowcast: nowcast.value, quotes: quotes.value,
      volatility: volatility.value, usdCorrelations: usdCorrelations.value, usdPeriods: usdPeriods.value,
      eventsBySeries: Object.fromEntries(events.value || []), marketDate, asOf: now.toISOString(),
      morningSnapshots: loadMorningProducts ? (morning.value || {}) : undefined,
      // With a history loader, a failed load still yields a board with structure marked unavailable.
      ...(riskRangeHistory ? { riskRangeHistory: riskRangeHistory.value || [], cryptoQuantHistory: cryptoQuantHistory?.value || [],
        allTimeHighs: allTimeHighs?.value || {} } : {}),
      // A failed volume load still yields a board whose volume reads unavailable.
      ...(volumeHistory ? { volumeHistory: volumeHistory.value || {} } : {}),
      // A failed load still yields a board whose Z-scores and CPI consensus read unavailable.
      ...(priceHistory ? { priceHistory: priceHistory.value || {} } : {}),
      ...(cpiConsensus ? { cpiConsensus: cpiConsensus.value || { releases: [] } } : {}),
      ...(publishedStatements?.value ? { publishedStatements: publishedStatements.value } : {}),
      // Today's board reads the live Alpha Code watch; an earlier day's research never does.
      ...(loadAlphaCodeWatch && !researchDate ? { alphaCodeWatch: await Promise.resolve().then(loadAlphaCodeWatch).catch(() => null) } : {}),
    });
    board.sourceStatus = Object.fromEntries(Object.entries({ riskRanges, cryptoQuant, hedgai, securityIntelligence,
      nowcast, quotes, volatility, usdCorrelations, kalshi: events, ...(loadMorningProducts ? { morningResearch: morning } : {}),
      ...(riskRangeHistory ? { riskRangeHistory } : {}), ...(cryptoQuantHistory ? { cryptoQuantHistory } : {}),
      ...(allTimeHighs ? { allTimeHighs } : {}), ...(volumeHistory ? { volumeHistory } : {}),
      ...(priceHistory ? { priceHistory } : {}), ...(cpiConsensus ? { cpiConsensus } : {}),
      ...(publishedStatements ? { publishedStatements } : {}) })
      .map(([key, result]) => [key, result.error ? 'failed' : 'ready']));
    return board;
  };
}

/** Cboe indices the dashboard snapshot does not carry but a market's gauge needs (e.g. VXSLV). */
const extraCboeSeries = () => UNIVERSE.markets.map((market) => market.volatility)
  .filter((spec) => spec?.cboeSymbol).map((spec) => ({ name: spec.key, symbol: spec.cboeSymbol }));

module.exports = { allTimeHighSymbols, alphaCodeBreaks, volumeSymbols, zScoreSymbols, buildSetupBoard, extraCboeSeries, createSetupBoardLoader, emailPublishedAt, evaluateSetup, eventSortKey, selectEvents,
  priceSymbols, seriesNames, tradeTickers };
