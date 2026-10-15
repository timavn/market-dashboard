const { zonedTimeToUtc } = require('date-fns-tz');
const { addCalendarDays, isTradingDateKey, previousTradingDateKey } = require('../utils/usEquityMarketCalendar.cjs');
const { membershipDateIsUsable } = require('../utils/marketDailyMembership.cjs');

const NY = 'America/New_York';
const QUOTE_AGE_MS = 20 * 60_000;
const SOURCE = 'Yahoo Finance';
const MEMBERSHIP_URL = 'https://www.ssga.com/us/en/intermediary/etfs/state-street-spdr-sp-500-etf-trust-spy';
const SECTORS = ['XLB', 'XLC', 'XLE', 'XLF', 'XLI', 'XLK', 'XLP', 'XLRE', 'XLU', 'XLV', 'XLY'];
const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: NY, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const positive = value => number(value) !== null && value > 0 ? value : null;
const canonical = value => typeof value === 'string' ? value.trim().toUpperCase().replace(/[./]/g, '-') : '';
const iso = value => Number.isFinite(value) ? new Date(value).toISOString() : null;
const get = (collection, key) => collection instanceof Map ? collection.get(key) ?? collection.get(canonical(key)) : collection?.[key] ?? collection?.[canonical(key)];

function eastern(ms) {
  const parts = Object.fromEntries(formatter.formatToParts(new Date(ms)).map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

function localTime(date, time) {
  return zonedTimeToUtc(`${date}T${time}`, NY).getTime();
}

function flagged(value, visited = new Set()) {
  if (!value || typeof value !== 'object' || visited.has(value)) return false;
  visited.add(value);
  const flags = ['mock', 'isMock', 'is_mock', 'fixture', 'isFixture', 'seed', 'seeded', 'isSeed', 'isSeeded', 'is_seeded',
    'stale', 'isStale', 'is_stale', 'cacheOnly', 'isCacheOnly', 'cache_only', 'cached', 'isCached', 'fromCache',
    'refreshFailed', 'offline', 'disconnected', 'synthetic', 'fallback', 'isFallback', 'modelOnly', 'portfolioDerived', 'inferred', 'costBasisDerived'];
  if (flags.some(key => value[key] === true) || value.connected === false || value.available === false) return true;
  if (/^(unavailable|error|offline|disconnected|stale|mock|seeded|cache.only|cached|synthetic|fallback)$/i.test(String(value.status || ''))) return true;
  const invalid = /unavailable|error|offline|disconnect|stale|mock|fixture|seed|synthetic|portfolio.derived|cost.basis|cache.only|cached|fallback|model.only|inferred/i;
  if (['source', 'provider', 'provenance', 'dataStatus', 'dataType', 'availability', 'freshness', 'warning'].some(key => typeof value[key] === 'string' && invalid.test(value[key]))) return true;
  return Object.values(value).some(child => child && typeof child === 'object' && flagged(child, visited));
}

function providerPeriods(result) {
  const periods = new Map();
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (positive(value.start) && positive(value.end)) {
      const start = value.start * 1000;
      const end = value.end * 1000;
      const date = eastern(start).date;
      if (isTradingDateKey(date) && eastern(start).minutes === 570 && end > start && end - start <= 390 * 60_000) {
        periods.set(date, { date, start, end });
      }
      return;
    }
    if (Array.isArray(value)) value.forEach(visit);
    else if (value.regular) visit(value.regular);
  }
  visit(result.meta?.tradingPeriods);
  visit(result.tradingPeriods);
  visit(result.meta?.currentTradingPeriod?.regular);
  return [...periods.values()].sort((a, b) => a.start - b.start);
}

function nextOpen(date, nowMs) {
  if (isTradingDateKey(date) && nowMs < localTime(date, '09:30:00')) return localTime(date, '09:30:00');
  let next = addCalendarDays(date, 1);
  while (!isTradingDateKey(next)) next = addCalendarDays(next, 1);
  return localTime(next, '09:30:00');
}

function parseContext(payload, { ticker, nowMs = Date.now(), sourceUrl } = {}) {
  if (!Number.isFinite(nowMs) || !canonical(ticker) || flagged(payload) || payload?.chart?.error) return null;
  const results = payload?.chart?.result;
  if (!Array.isArray(results) || results.length !== 1) return null;
  const result = results[0];
  const meta = result?.meta;
  if (canonical(meta?.symbol) !== canonical(ticker) || meta?.currency !== 'USD'
    || !['EQUITY', 'ETF'].includes(meta?.instrumentType)
    || !['America/New_York', 'US/Eastern'].includes(meta?.exchangeTimezoneName)) return null;
  const observedMs = positive(meta.regularMarketTime) * 1000;
  const price = positive(meta.regularMarketPrice);
  if (!observedMs || !price || observedMs > nowMs + 5_000) return null;
  const current = eastern(nowMs);
  const marketDate = eastern(observedMs).date;
  if (!isTradingDateKey(marketDate)) return null;
  const periods = providerPeriods(result);
  const providerCurrent = meta.currentTradingPeriod?.regular;
  if (!positive(providerCurrent?.start) || !positive(providerCurrent?.end)) return null;
  const todayPeriod = periods.find(period => period.date === current.date);
  const tradingToday = isTradingDateKey(current.date);
  const todayStart = todayPeriod?.start ?? localTime(current.date, '09:30:00');
  const todayEnd = todayPeriod?.end ?? localTime(current.date, '16:00:00');
  const open = tradingToday && nowMs >= todayStart && nowMs < todayEnd;
  let status;
  let period = periods.find(item => item.date === marketDate);
  if (open) {
    // A stale provider session cannot establish a current cash session.
    if (!todayPeriod || marketDate !== current.date || observedMs < todayStart || nowMs - observedMs > QUOTE_AGE_MS) return null;
    status = 'delayed';
  } else {
    const expected = tradingToday && nowMs >= todayEnd ? current.date : previousTradingDateKey(current.date);
    if (marketDate !== expected) return null;
    // Older chart responses sometimes publish only the upcoming trading period.
    // A regular 16:00 close remains verifiable; an early close requires its
    // provider-published period instead of treating an arbitrary 13:00 trade as a close.
    period = period || { date: marketDate, start: localTime(marketDate, '09:30:00'), end: localTime(marketDate, '16:00:00') };
    if (observedMs < period.end - 60_000 || observedMs > period.end + 5 * 60_000 || nowMs < period.end) return null;
    status = 'last-close';
  }
  if (!period) return null;
  let url = sourceUrl || `https://finance.yahoo.com/quote/${encodeURIComponent(meta.symbol)}/history/`;
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== 'https:' || !/(^|\.)yahoo\.com$/.test(parsedUrl.hostname)) return null;
    url = parsedUrl.href;
  } catch { return null; }
  return {
    result, meta, periods, observedMs, price, ticker, marketDate, status,
    asOf: iso(observedMs), source: SOURCE, sourceUrl: url,
    expiresAt: iso(open ? observedMs + QUOTE_AGE_MS : nextOpen(current.date, nowMs)),
    sessionStart: period.start, sessionEnd: period.end, _verified: 'yahoo-chart',
  };
}

function parseBars(result, nowMs) {
  const quote = result.indicators?.quote?.[0];
  if (!quote || !Array.isArray(result.timestamp)) return [];
  const byTime = new Map();
  for (let i = 0; i < result.timestamp.length; i += 1) {
    const timestamp = positive(result.timestamp[i]) * 1000;
    if (!timestamp || timestamp > nowMs + 5_000 || byTime.has(timestamp)) continue;
    const date = eastern(timestamp).date;
    if (!isTradingDateKey(date)) continue;
    const high = positive(quote.high?.[i]);
    const low = positive(quote.low?.[i]);
    const close = positive(quote.close?.[i]);
    const open = positive(quote.open?.[i]);
    const volume = number(quote.volume?.[i]);
    byTime.set(timestamp, { timestamp, date, open, high, low, close, volume: volume !== null && volume >= 0 ? volume : null });
  }
  return [...byTime.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function publishedDailyField(primary, secondary, primarySource, secondarySource) {
  if (primary !== null && primary !== undefined) {
    if (!positive(primary)) return { value: null, source: null };
    if (positive(secondary) && Math.abs(primary - secondary) > Math.max(0.01, primary * 0.0001)) return { value: null, source: null };
    return { value: primary, source: primarySource };
  }
  return positive(secondary) ? { value: secondary, source: secondarySource } : { value: null, source: null };
}

function parseDailyChart(payload, options = {}) {
  const context = parseContext(payload, options);
  if (!context || context.meta.dataGranularity !== '1d') return null;
  const bars = parseBars(context.result, options.nowMs ?? Date.now());
  const previousDate = previousTradingDateKey(context.marketDate);
  const previous = bars.find(bar => bar.date === previousDate);
  const current = bars.find(bar => bar.date === context.marketDate);
  const currentIndex = current ? context.result.timestamp.findIndex(timestamp => timestamp * 1000 === current.timestamp) : -1;
  const dailyQuote = context.result.indicators?.quote?.[0];
  if (!previous?.close) return null;
  if (context.status === 'last-close') {
    if (!current) return null;
    if (current.close) {
      if (Math.abs(current.close - context.price) > Math.max(0.01, context.price * 0.0001)) return null;
    } else {
      const publishedClose = dailyQuote?.close?.[currentIndex];
      // Yahoo can publish its regular-market closing price and exact closing
      // timestamp before filling the duplicate close in today's daily bar.
      // That independently published close is usable once the provider's
      // regular session has ended. Preserve the missing historical cell;
      // never substitute an extended-hours price or a pre-close last trade.
      if ((publishedClose !== null && publishedClose !== undefined) || context.observedMs < context.sessionEnd) return null;
    }
  }
  const rawOpen = dailyQuote?.open?.[currentIndex];
  const open = publishedDailyField(rawOpen, null, 'daily.open', null);
  const high = publishedDailyField(dailyQuote?.high?.[currentIndex], context.meta.regularMarketDayHigh, 'daily.high', 'meta.regularMarketDayHigh');
  const low = publishedDailyField(dailyQuote?.low?.[currentIndex], context.meta.regularMarketDayLow, 'daily.low', 'meta.regularMarketDayLow');
  const tolerance = Math.max(0.01, context.price * 0.0001);
  if (high.value !== null && high.value + tolerance < context.price) { high.value = null; high.source = null; }
  if (low.value !== null && low.value - tolerance > context.price) { low.value = null; low.source = null; }
  const events = context.result.events || {};
  const splitDates = [...new Set(Object.values(events.splits || {}).filter(event => positive(event?.date))
    .map(event => eastern(event.date * 1000).date))].sort();
  const corporateActionToday = ['splits', 'dividends', 'capitalGains'].some(type => Object.values(events[type] || {}).some(event =>
    positive(event?.date) && eastern(event.date * 1000).date === context.marketDate));
  const { result: _result, meta: _meta, observedMs: _observedMs, ...base } = context;
  // Daily chart closes can carry float32 storage noise (105.019996643 vs
  // the published 105.02). Do not turn an unchanged quote into a decliner.
  // Keep raw observations intact and tolerate only that representation error.
  const difference = context.price - previous.close;
  const changePercent = Math.abs(difference) <= Math.max(context.price, previous.close) * (2 ** -24)
    ? 0 : (difference / previous.close) * 100;
  return {
    ...base, price: context.price, previousClose: previous.close,
    changePercent,
    open: open.value, high: high.value, low: low.value, openMissing: rawOpen === null || rawOpen === undefined,
    fieldSources: { price: 'meta.regularMarketPrice', open: open.source, high: high.source, low: low.source },
    bars, corporateActionToday, splitDates,
  };
}

function parseIntradayChart(payload, options = {}) {
  const context = parseContext(payload, options);
  const match = context?.meta.dataGranularity?.match(/^(5|15|30|60)m$/);
  if (!context || !match) return null;
  const intervalMs = Number(match[1]) * 60_000;
  const bars = parseBars(context.result, options.nowMs ?? Date.now()).filter(bar => {
    const minutes = eastern(bar.timestamp).minutes;
    return minutes >= 570 && minutes < 960;
  });
  const { result: _result, meta: _meta, observedMs: _observedMs, ...base } = context;
  return { ...base, intervalMs, bars, previousClose: null, changePercent: null };
}

function mergeIntradayHistory(history, current) {
  if (!current || current._verified !== 'yahoo-chart' || flagged(current)) return null;
  if (!history || history._verified !== 'yahoo-chart' || flagged(history)
    || canonical(history.ticker) !== canonical(current.ticker) || history.intervalMs !== current.intervalMs) return current;
  const bars = [...new Map([...history.bars.filter(bar => bar.date < current.marketDate), ...current.bars]
    .map(bar => [bar.timestamp, bar])).values()].sort((a, b) => a.timestamp - b.timestamp);
  const dates = new Set([...new Set(bars.map(bar => bar.date))].sort().slice(-61));
  const periods = [...new Map([...history.periods.filter(period => period.date < current.marketDate), ...current.periods]
    .map(period => [period.date, period])).values()].sort((a, b) => a.start - b.start);
  return { ...current, bars: bars.filter(bar => dates.has(bar.date)), periods: periods.filter(period => dates.has(period.date)) };
}

function validParsed(row, ticker, nowMs) {
  return row && row._verified === 'yahoo-chart' && !flagged(row) && canonical(row.ticker) === canonical(ticker)
    && positive(row.price) && Number.isFinite(Date.parse(row.asOf)) && Date.parse(row.asOf) <= nowMs + 5_000
    && Date.parse(row.expiresAt) > nowMs && ['delayed', 'last-close'].includes(row.status)
    && typeof row.sourceUrl === 'string' && Array.isArray(row.bars);
}

function completeHistory(row, count, fields = ['close']) {
  const byDate = new Map(row.bars.filter(bar => bar.date < row.marketDate).map(bar => [bar.date, bar]));
  const result = [];
  let date = row.marketDate;
  for (let i = 0; i < count; i += 1) {
    date = previousTradingDateKey(date);
    const bar = byDate.get(date);
    if (!bar || fields.some(field => !positive(bar[field]))) return null;
    result.push(bar);
  }
  return result;
}

function metricHistory(row) {
  const fifty = completeHistory(row, 49);
  const twoHundred = completeHistory(row, 199);
  let yearCount = 0;
  let date = previousTradingDateKey(row.marketDate);
  const boundary = addCalendarDays(row.marketDate, -364);
  while (date >= boundary) { yearCount += 1; date = previousTradingDateKey(date); }
  const year = completeHistory(row, yearCount, ['high', 'low']);
  return {
    above50: fifty ? row.price > (fifty.reduce((sum, bar) => sum + bar.close, row.price) / 50) : null,
    above200: twoHundred ? row.price > (twoHundred.reduce((sum, bar) => sum + bar.close, row.price) / 200) : null,
    newHigh: year && positive(row.high) ? row.high > Math.max(...year.map(bar => bar.high)) : null,
    newLow: year && positive(row.low) ? row.low < Math.min(...year.map(bar => bar.low)) : null,
  };
}

function displayRow(member, quote, extra = {}) {
  return { ticker: member.ticker, name: member.name || member.ticker, changePercent: quote.changePercent,
    asOf: quote.asOf, expiresAt: quote.expiresAt, status: quote.status, marketDate: quote.marketDate, source: quote.source, sourceUrl: quote.sourceUrl,
    delayedSource: true, detail: '', ...extra };
}

function percentile(sortedValues, fraction) {
  const index = (sortedValues.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * (index - lower);
}

function sessionSample(intraday, date, completedMs) {
  const period = intraday.periods.find(item => item.date === date);
  // Short sessions have a different volume pattern; do not include them in
  // the ordinary-session baseline or extrapolate their missing afternoon.
  if (!period || period.end - period.start !== 390 * 60_000 || completedMs > period.end - period.start) return null;
  const count = Math.floor(completedMs / intraday.intervalMs);
  if (!count) return null;
  const byTime = new Map(intraday.bars.filter(bar => bar.date === date).map(bar => [bar.timestamp, bar]));
  const bars = [];
  for (let i = 0; i < count; i += 1) {
    const bar = byTime.get(period.start + i * intraday.intervalMs);
    if (!bar?.close || bar.volume === null) return null;
    bars.push(bar);
  }
  return { close: bars[bars.length - 1].close, volume: bars.reduce((sum, bar) => sum + bar.volume, 0), cutoff: period.start + count * intraday.intervalMs };
}

function intradayMetrics(daily, intraday, nowMs) {
  if (!validParsed(intraday, daily.ticker, nowMs) || intraday.marketDate !== daily.marketDate || !positive(intraday.intervalMs)) return null;
  const quoteCutoff = Math.min(Date.parse(daily.asOf), Date.parse(intraday.asOf), intraday.sessionEnd);
  const completedMs = Math.floor((quoteCutoff - intraday.sessionStart) / intraday.intervalMs) * intraday.intervalMs;
  const sample = sessionSample(intraday, daily.marketDate, completedMs);
  if (!sample) return null;
  const byDate = new Map(daily.bars.map(bar => [bar.date, bar]));
  const periodByDate = new Map(intraday.periods.map(period => [period.date, period]));
  const oldestPeriodDate = [...periodByDate.keys()].sort()[0];
  const previousSessions = [];
  let previousDate = previousTradingDateKey(daily.marketDate);
  while (previousDate >= oldestPeriodDate && previousSessions.length < 40) {
    const period = periodByDate.get(previousDate);
    // Skip a positively evidenced short session; a missing session is a gap
    // in coverage and must not quietly be replaced by an older observation.
    if (!period || period.end - period.start === 390 * 60_000) previousSessions.push(period || { date: previousDate, missing: true });
    previousDate = previousTradingDateKey(previousDate);
  }
  const samples = previousSessions.map(period => {
    if (period.missing) return null;
    const historic = sessionSample(intraday, period.date, completedMs);
    const previousClose = byDate.get(previousTradingDateKey(period.date))?.close;
    return historic && previousClose ? { ...historic, returnPercent: (historic.close / previousClose - 1) * 100 } : null;
  });
  const baseline20 = samples.slice(0, 20);
  const splitInLookback = count => (daily.splitDates || []).some(date =>
    date >= previousSessions[Math.min(count, previousSessions.length) - 1]?.date && date <= daily.marketDate);
  const baselineVolume = baseline20.length === 20 && baseline20.every(Boolean) && !splitInLookback(20)
    ? baseline20.reduce((sum, item) => sum + item.volume, 0) / 20 : null;
  const returnPercent = (sample.close / daily.previousClose - 1) * 100;
  const gainEligible = samples.length === 40 && samples.every(Boolean) && !splitInLookback(40);
  const largestGain = gainEligible && returnPercent > 0
    && samples.every(item => returnPercent > item.returnPercent);
  return { ratio: baselineVolume > 0 ? sample.volume / baselineVolume : null, largestGain,
    gainEligible, comparisonReturn: returnPercent, cutoff: iso(sample.cutoff), intervalMinutes: intraday.intervalMs / 60_000 };
}

function openingObservation(daily, intraday, nowMs) {
  if (positive(daily.open)) return { price: daily.open, source: daily.source, sourceUrl: daily.sourceUrl, asOf: iso(daily.sessionStart), field: 'daily.open' };
  if (!daily.openMissing || !validParsed(intraday, daily.ticker, nowMs)
    || intraday.marketDate !== daily.marketDate || intraday.status !== daily.status || intraday.sessionStart !== daily.sessionStart) return null;
  const firstBar = intraday.bars.find(bar => bar.timestamp === intraday.sessionStart && bar.date === daily.marketDate);
  return positive(firstBar?.open) ? { price: firstBar.open, source: intraday.source, sourceUrl: intraday.sourceUrl,
    asOf: iso(firstBar.timestamp), field: 'first regular-session bar.open', intraday } : null;
}

function buildMarketDailySnapshot({ members = [], dailyByTicker, intradayByTicker, sectorByTicker, sectorDailyByTicker, membershipAsOf, nowMs = Date.now() } = {}) {
  if (!Array.isArray(members)) members = [];
  const snapshot = {
    status: 'unavailable', asOf: null, expiresAt: null, marketDate: null, quoteStatus: null,
    universe: { label: 'S&P 500 · SPY', count: members.length, asOf: membershipAsOf || null },
    source: 'State Street / Yahoo Finance', sourceUrl: MEMBERSHIP_URL,
    coverage: { quotes: 0, total: members.length, history50: 0, history200: 0, year: 0, intraday: 0, intradayVolume: 0, intradayGain: 0, sectorComparisons: 0, reversalComparisons: 0 },
    breadth: { advancing: null, declining: null, unchanged: null, above50Pct: null, above200Pct: null, newHighs: null, newLows: null, medianReturn: null,
      upOnePercent: null, downOnePercent: null, lowerQuartileReturn: null, upperQuartileReturn: null },
    winners: [], losers: [], leadership: { leadingSector: null, laggingSector: null, lift: null, drag: null },
    moverDetails: { winners: [], losers: [] },
    leadershipDetails: { leadingSectors: [], laggingSectors: [], lifts: [], drags: [], sectorParticipation: null },
    outliers: { relativeVolume: null, unusualGain: null, reversal: null, againstSector: null },
    outlierDetails: { relativeVolume: [], unusualGain: [], reversal: [], againstSector: [] },
  };
  if (!Number.isFinite(nowMs) || !Array.isArray(members) || !members.length
    || members.some(member => !canonical(member?.ticker)) || new Set(members.map(member => canonical(member.ticker))).size !== members.length) return snapshot;
  if (!membershipDateIsUsable(membershipAsOf, nowMs)) return snapshot;
  const verified = members.map(member => ({ member, quote: get(dailyByTicker, member.ticker) }))
    .filter(({ member, quote }) => validParsed(quote, member.ticker, nowMs) && number(quote.changePercent) !== null && positive(quote.previousClose));
  const coherent = new Set(verified.map(({ quote }) => `${quote.marketDate}:${quote.status}`)).size <= 1;
  if (!coherent) return snapshot;
  snapshot.coverage.quotes = verified.length;
  const complete = verified.length === members.length;
  const metricRows = verified.map(({ quote }) => metricHistory(quote));
  snapshot.coverage.history50 = metricRows.filter(row => row.above50 !== null).length;
  snapshot.coverage.history200 = metricRows.filter(row => row.above200 !== null).length;
  snapshot.coverage.year = metricRows.filter(row => row.newHigh !== null && row.newLow !== null).length;
  if (complete) {
    const returns = verified.map(({ quote }) => quote.changePercent).sort((a, b) => a - b);
    const middle = Math.floor(returns.length / 2);
    Object.assign(snapshot.breadth, {
      advancing: returns.filter(value => value > 0).length, declining: returns.filter(value => value < 0).length,
      unchanged: returns.filter(value => value === 0).length,
      medianReturn: returns.length % 2 ? returns[middle] : (returns[middle - 1] + returns[middle]) / 2,
      upOnePercent: returns.filter(value => value >= 1).length, downOnePercent: returns.filter(value => value <= -1).length,
      lowerQuartileReturn: percentile(returns, 0.25), upperQuartileReturn: percentile(returns, 0.75),
      // Recently listed members may not yet have 200 days or a full year.
      // The UI must show each metric's explicit coverage rather than implying
      // that a value calculated from eligible history covers the full roster.
      above50Pct: snapshot.coverage.history50 > 0 ? metricRows.filter(row => row.above50).length / snapshot.coverage.history50 * 100 : null,
      above200Pct: snapshot.coverage.history200 > 0 ? metricRows.filter(row => row.above200).length / snapshot.coverage.history200 * 100 : null,
      newHighs: snapshot.coverage.year > 0 ? metricRows.filter(row => row.newHigh).length : null,
      newLows: snapshot.coverage.year > 0 ? metricRows.filter(row => row.newLow).length : null,
    });
    const ranked = [...verified].sort((a, b) => b.quote.changePercent - a.quote.changePercent || a.member.ticker.localeCompare(b.member.ticker));
    snapshot.moverDetails.winners = ranked.filter(item => item.quote.changePercent > 0).slice(0, 5).map(({ member, quote }) => displayRow(member, quote));
    snapshot.moverDetails.losers = ranked.filter(item => item.quote.changePercent < 0)
      .sort((a, b) => a.quote.changePercent - b.quote.changePercent || a.member.ticker.localeCompare(b.member.ticker))
      .slice(0, 5).map(({ member, quote }) => displayRow(member, quote));
    snapshot.winners = snapshot.moverDetails.winners.slice(0, 3);
    snapshot.losers = snapshot.moverDetails.losers.slice(0, 3);
    const weightsValid = members.every(member => number(member.weightPct) !== null && member.weightPct >= 0 && member.weightPct <= 100)
      && members.reduce((sum, member) => sum + member.weightPct, 0) <= 100.5;
    if (weightsValid) {
      const contributions = verified.map(({ member, quote }) => displayRow(member, quote, {
        contributionPp: member.weightPct * quote.changePercent / 100,
        detail: `SPY holdings-weight contribution estimate · weights ${membershipAsOf}`,
      })).sort((a, b) => b.contributionPp - a.contributionPp || a.ticker.localeCompare(b.ticker));
      snapshot.leadershipDetails.lifts = contributions.filter(row => row.contributionPp > 0).slice(0, 2);
      snapshot.leadershipDetails.drags = contributions.filter(row => row.contributionPp < 0)
        .sort((a, b) => a.contributionPp - b.contributionPp || a.ticker.localeCompare(b.ticker)).slice(0, 2);
      snapshot.leadership.lift = snapshot.leadershipDetails.lifts[0] || null;
      snapshot.leadership.drag = snapshot.leadershipDetails.drags[0] || null;
    }
  }
  const sectors = SECTORS.map(ticker => ({ ticker, quote: get(sectorDailyByTicker, ticker) }))
    .filter(({ ticker, quote }) => validParsed(quote, ticker, nowMs) && number(quote.changePercent) !== null);
  const sectorCoherent = new Set([...verified, ...sectors].map(({ quote }) => `${quote.marketDate}:${quote.status}`)).size <= 1;
  if (sectors.length === SECTORS.length && sectorCoherent) {
    sectors.sort((a, b) => b.quote.changePercent - a.quote.changePercent || a.ticker.localeCompare(b.ticker));
    const sectorRow = item => displayRow({ ticker: item.ticker, name: item.quote.name || item.ticker }, item.quote, { detail: 'Sector ETF · 11-sector comparison' });
    snapshot.leadershipDetails.leadingSectors = sectors.slice(0, 2).map(sectorRow);
    snapshot.leadershipDetails.laggingSectors = [...sectors]
      .sort((a, b) => a.quote.changePercent - b.quote.changePercent || a.ticker.localeCompare(b.ticker)).slice(0, 2).map(sectorRow);
    snapshot.leadershipDetails.sectorParticipation = {
      advancing: sectors.filter(({ quote }) => quote.changePercent > 0).length,
      declining: sectors.filter(({ quote }) => quote.changePercent < 0).length,
      unchanged: sectors.filter(({ quote }) => quote.changePercent === 0).length,
      total: sectors.length,
    };
    snapshot.leadership.leadingSector = snapshot.leadershipDetails.leadingSectors[0];
    snapshot.leadership.laggingSector = snapshot.leadershipDetails.laggingSectors[0];
  }
  const relativeVolume = [];
  const unusualGain = [];
  const reversals = [];
  const againstSector = [];
  const intradayEvidence = [];
  const sectorMap = new Map(sectors.map(item => [item.ticker, item.quote]));
  for (const { member, quote } of verified) {
    const intraday = get(intradayByTicker, member.ticker);
    const metrics = intradayMetrics(quote, intraday, nowMs);
    if (metrics) snapshot.coverage.intraday += 1;
    if (quote.corporateActionToday) continue;
    if (metrics?.ratio !== null && metrics?.ratio !== undefined) snapshot.coverage.intradayVolume += 1;
    if (metrics?.gainEligible) snapshot.coverage.intradayGain += 1;
    if (metrics?.ratio >= 2 || metrics?.largestGain) intradayEvidence.push(intraday);
    if (metrics?.ratio >= 2) relativeVolume.push(displayRow(member, quote, {
      ratio: metrics.ratio, cutoff: metrics.cutoff,
      sourceUrl: intraday.sourceUrl,
      detail: `Versus 20 prior full sessions at the same elapsed time · completed ${metrics.intervalMinutes}-minute bars`,
    }));
    if (metrics?.largestGain) unusualGain.push(displayRow(member, quote, {
      sessions: 40, comparisonReturn: metrics.comparisonReturn, cutoff: metrics.cutoff,
      changePercent: metrics.comparisonReturn, sourceUrl: intraday.sourceUrl,
      detail: `Largest same-time gain versus 40 prior full sessions · completed ${metrics.intervalMinutes}-minute bars`,
    }));
    const opening = openingObservation(quote, intraday, nowMs);
    const gapPercent = opening ? (opening.price / quote.previousClose - 1) * 100 : null;
    if (gapPercent !== null) snapshot.coverage.reversalComparisons += 1;
    if (gapPercent !== null && Math.abs(gapPercent) >= 0.5 && Math.abs(quote.changePercent) >= 0.5 && gapPercent * quote.changePercent < 0) {
      if (opening.intraday) intradayEvidence.push(opening.intraday);
      const { intraday: _intraday, ...openingEvidence } = opening;
      const detail = ['Opening gap reversed across the previous close',
        ...(opening.intraday ? [`Opening evidence: ${opening.field} · ${opening.source}`, opening.sourceUrl] : []),
      ].join('\n');
      reversals.push(displayRow(member, quote, { gapPercent, openingEvidence, detail }));
    }
    const mapping = get(sectorByTicker, member.ticker);
    const sectorTicker = typeof mapping === 'string' ? mapping : mapping?.sectorTicker || mapping?.ticker;
    const sectorQuote = sectorMap.get(sectorTicker);
    const sectorComparable = sectorQuote && sectorQuote.marketDate === quote.marketDate && sectorQuote.status === quote.status;
    if (sectorComparable) snapshot.coverage.sectorComparisons += 1;
    if (sectorComparable && Math.abs(quote.changePercent) >= 1 && Math.abs(sectorQuote.changePercent) >= 0.25 && sectorQuote.changePercent * quote.changePercent < 0) {
      againstSector.push(displayRow(member, quote, { sectorChangePercent: sectorQuote.changePercent,
        sectorName: mapping?.sectorName || mapping?.name || sectorQuote.name || sectorTicker,
        detail: 'Moving opposite its sector ETF',
      }));
    }
  }
  const outlierGroups = [
    ['relativeVolume', relativeVolume, (a, b) => b.ratio - a.ratio, snapshot.coverage.intradayVolume],
    ['unusualGain', unusualGain, (a, b) => b.comparisonReturn - a.comparisonReturn, snapshot.coverage.intradayGain],
    ['reversal', reversals, (a, b) => Math.abs(b.changePercent - b.gapPercent) - Math.abs(a.changePercent - a.gapPercent), snapshot.coverage.reversalComparisons],
    ['againstSector', againstSector, (a, b) => Math.abs(b.changePercent - b.sectorChangePercent) - Math.abs(a.changePercent - a.sectorChangePercent), snapshot.coverage.sectorComparisons],
  ];
  for (const [key, rows, compare, coverage] of outlierGroups) {
    snapshot.outlierDetails[key] = rows.sort((a, b) => compare(a, b) || a.ticker.localeCompare(b.ticker)).slice(0, 3)
      .map(row => ({ ...row, detail: `${row.detail} · among ${coverage} verified of ${members.length} members` }));
    snapshot.outliers[key] = snapshot.outlierDetails[key][0] || null;
  }
  const observations = [...verified.map(item => item.quote), ...sectors.map(item => item.quote), ...intradayEvidence];
  if (observations.length) {
    snapshot.marketDate = observations[0].marketDate;
    snapshot.quoteStatus = observations[0].status;
    snapshot.asOf = iso(Math.min(...observations.map(row => Date.parse(row.asOf))));
    snapshot.expiresAt = iso(Math.min(...observations.map(row => Date.parse(row.expiresAt))));
    snapshot.status = complete && sectors.length === SECTORS.length && snapshot.coverage.year === members.length
      && snapshot.coverage.history200 === members.length ? 'available' : 'partial';
  }
  return snapshot;
}

module.exports = { parseDailyChart, parseIntradayChart, mergeIntradayHistory, buildMarketDailySnapshot, validParsed };
