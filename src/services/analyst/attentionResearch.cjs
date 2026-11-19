const { createHash } = require('node:crypto');
const { evaluatePortfolioRule } = require('../../utils/portfolioReviewRules.js');
const { sourceActionEvidence, describeAnalystFinding } = require('../../utils/analystFindingPresentation.cjs');
const { STANCE_PRODUCTS, foldStanceEvents, scanHoldings, stanceCall } = require('./stanceBook.cjs');
const { MESSAGE_ID, TERM } = require('../../utils/sourceEmailClip.cjs');
const { alphaCodeVerdict, brokenAlphaCodeLine } = require('./alphaCodeWatch.cjs');
const { sessionsBetween } = require('./marketLevels.cjs');

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const symbolOf = value => ({ 'BRK-B': 'BRK.B', 'BRK B': 'BRK.B', 'BF-B': 'BF.B' }[String(value).toUpperCase()] || String(value || '').toUpperCase());
// A citation to an emailed publication names the stored email and its ticker, so the
// Source popover can show the original clipped around that ticker.
// A name that cannot be searched for ("Market") still opens the email, just unmarked.
const emailClip = (messageId, ticker) => (MESSAGE_ID.test(String(messageId || ''))
  ? { sourceMessageId: messageId, ...(TERM.test(String(ticker || '')) ? { clipTicker: ticker } : {}) } : {});
// A citation stored by its email's address or file path opens that email too.
const STORED_EMAIL = /(?:gmail:\/\/message\/|\/messages\/\d{4}-\d{2}-\d{2}\/[^/]+\/)([a-f0-9]{8,32})/i;
function withActualEmail(citation, symbol) {
  if (!citation || citation.sourceMessageId) return citation;
  const stored = String(citation.sourceUri || citation.sourceUrl || '').match(STORED_EMAIL)?.[1];
  return stored ? { ...citation, ...emailClip(stored, symbol) } : citation;
}
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const time = value => Date.parse(value);
// The display name from the central security record (/api/security-universe identity).
const securityName = (context, symbol) => {
  const field = context.securities?.[symbol]?.identity?.displayName;
  return field?.status === 'available' && typeof field.value === 'string' && field.value.trim() ? field.value.trim() : null;
};
const invalid = value => !value || value.connected === false || ['stale', 'isStale', 'cacheOnly', 'cachedOnly', 'cached', 'fromCache', 'from_cache', 'mock', 'isMock', 'seed', 'seeded', 'fixture', 'synthetic', 'inferred', 'fallback', 'refreshFailed'].some(flag => value[flag] === true)
  || ['status', 'freshness', 'source', 'provider'].some(key => /^(?:unavailable|unverified|offline|disconnected|error|failed|stale|cache[-_ ]?only|cached|mock|seed(?:ed)?|fixture|synthetic|inferred|fallback)$/i.test(String(value[key] || '')))
  || ['metadata', 'provenance'].some(key => value[key] && typeof value[key] === 'object' && invalid(value[key]));
const dated = (value, now) => Number.isFinite(time(value)) && time(value) <= now.getTime();
const linked = citation => citation && (citation.id || citation.sourceUri || citation.sourceUrl || citation.url);
const row = (label, value) => ({ label, text: value });
const pct = value => `${value.toFixed(2)}%`;
// Each security has its own MIN / MAX, so a sizing alert states them rather
// than relying on the reader to remember the band. ATR and the stop get their own lines.
const processLimitRow = rule => row('Process limits', `MIN ${pct(rule.minWeight)} / ${number(rule.maxWeight) !== null ? `MAX ${pct(rule.maxWeight)}` : 'MAX unavailable'}`);
function processLimitRows(rule) {
  if (number(rule.minWeight) === null) return [];
  return [processLimitRow(rule),
    ...(number(rule.atrPct) !== null ? [row('ATR', `${pct(rule.atrPct)} of price${rule.atrFloorApplied ? ' (1.25% floor sets the band)' : ''}`)] : []),
    ...(number(rule.stopPrice) !== null ? [row('Stop', `${rule.stopPrice.toFixed(2)} · 2 × ATR from last close${number(rule.stopLossPctNlv) !== null ? ` · ${pct(rule.stopLossPctNlv)} of NLV at this weight` : ''}`)] : [])];
}
function freshBook(book, now) {
  return book?.liveVerified === true && book.complete === true && !invalid(book)
    && (!book.freshness || book.freshness === 'live')
    && Number.isFinite(time(book.asOf)) && now.getTime() - time(book.asOf) <= 60000 && time(book.asOf) <= now.getTime() + 30000
    && Array.isArray(book.positions) && book.positions.every(position => !invalid(position) && number(position.quantity) !== null && symbolOf(position.symbol));
}
function holdingState(book, symbol, verified, now) {
  if (!verified) return { holdingsVerified: false, quantity: null, currentHolding: null };
  const quantity = book.positions.filter(position => position.category !== 'event_contract' && symbolOf(position.symbol) === symbol).reduce((sum, position) => sum + position.quantity, 0);
  const matches = (book.currentHoldings || []).filter(position => symbolOf(position.holding) === symbol && position.quantity === quantity);
  const weight = matches.length === 1 ? matches[0].currentHolding : null;
  const currentHolding = weight && !invalid(weight) && weight.source === 'ibkr' && weight.basis === 'absolute_market_value_over_net_liquidation'
    && number(weight.weightPct) !== null && weight.weightPct >= 0 && dated(weight.asOf, new Date(now.getTime() + 30000))
    && now.getTime() - time(weight.asOf) <= 60000 ? weight : null;
  return { holdingsVerified: true, holdingsVerifiedAt: book.asOf, quantity, currentHolding };
}
const shares = value => Number.isInteger(value) ? String(value) : value.toFixed(2);
// Shares scale with weight at one price, so the order needs no quote: a market
// order sized from the verified quantity and the target / current weight ratio.
function orderText(quantity, keepRatio) {
  if (!number(quantity) || number(keepRatio) === null || keepRatio < 0 || keepRatio >= 1) return null;
  const held = Math.abs(quantity);
  const remaining = Math.round(held * keepRatio * 100) / 100;
  const trade = Math.round((held - remaining) * 100) / 100;
  if (trade <= 0) return null;
  return `${quantity > 0 ? 'Sell' : 'Buy'} ${shares(trade)} ${trade === 1 ? 'share' : 'shares'}`;
}
function positionRows(state) {
  if (!state.holdingsVerified) return [];
  return [row('Current position', state.quantity > 0 ? 'Long' : state.quantity < 0 ? 'Short' : 'Not held'),
    ...(state.currentHolding ? [row('Position size', `${state.currentHolding.weightPct.toFixed(2)}%`)] : [])];
}
// A source instruction that opposes a held position needs an immediate decision.
// It is shown apart from ordinary findings and is never cleared by reading it.
const ACTION_REQUIRED = 'action-required';
function finding({ key, material, symbol, kind, action, publishedAt, rows, sourceLinks, state = {}, priority = 1, severity = null }) {
  const id = `attention:${kind}:${hash(key).slice(0, 28)}`;
  // Escalation is a material change, so an already-read finding becomes unread.
  return { attentionVersion: 1, id, sourceId: id, symbol, action, state: 'open', kind, priority, ...(severity ? { severity } : {}),
    publicationTime: new Date(publishedAt).toISOString(), fingerprint: hash(severity ? [material, severity] : material), ...state,
    presentation: { subject: symbol, date: String(publishedAt).slice(0, 10), rows,
      sourceLinks: sourceLinks.map(link => ({ ...link, citation: withActualEmail(link.citation, symbol) })).filter(link => linked(link.citation)).filter((link, i, all) => all.findIndex(other => (other.citation.id || other.citation.sourceUri) === (link.citation.id || link.citation.sourceUri)) === i) } };
}
function signalEvidence(holding, field, now) {
  const source = holding.sources?.[field];
  return ['BULLISH', 'BEARISH', 'NEUTRAL'].includes(holding[field]) && source && !invalid(source) && dated(source.publishedAt, now) && linked(source.citation)
    && holding.signalContext?.[field]?.status !== 'indication' && holding.signalContext?.[field]?.status !== 'conflict';
}
const DURATIONS = [['tick', 'Tick'], ['trade', 'Trade'], ['trend', 'Trend'], ['tail', 'Tail']];
const SIGNALS = ['BULLISH', 'BEARISH', 'NEUTRAL'];
// Real-Time Alerts and ETF Pro list only their strongest ideas, so a name they
// currently list Long reads bullish Trade and Trend, and Short bearish. A trim
// leaves it listed. A removal or exit says only that Trade and/or Trend broke,
// so neither direction is known. Both come from the list, not a stated reading.
const LISTING_SLOTS = ['etf-pro:long', 'etf-pro:short', 'real-time-alert'];
const LISTED_BIAS = { LONG: 'BULLISH', REDUCE_LONG: 'BULLISH', SHORT: 'BEARISH', REDUCE_SHORT: 'BEARISH' };
function listingBias(book, symbol) {
  const entries = LISTING_SLOTS.map(slot => ({ ...book?.tickers?.[symbol]?.[slot], slot })).filter(entry => entry.stance && entry.date);
  if (!entries.length) return null;
  // Ordered as the stance book orders them: market date, then publication.
  const key = entry => `${entry.date}|${entry.at || ''}`;
  const latest = entries.map(key).sort().at(-1);
  const newest = entries.filter(entry => key(entry) === latest);
  const values = [...new Set(newest.map(entry => LISTED_BIAS[entry.stance]).filter(Boolean))];
  const at = Math.max(...newest.map(entry => time(entry.at) || time(entry.date)));
  // One edition can remove a Long and add a Short; the listing is the current state.
  const said = entry => { const call = stanceCall(entry); return `${call.product} ${call.action} ${monthDay(call.date)}`; };
  if (values.length === 1) {
    const listing = newest.find(entry => LISTED_BIAS[entry.stance]);
    return { value: values[0], at, basis: 'inferred', note: `Inferred from list membership (${said(listing)}); not stated by the source` };
  }
  const exit = newest.find(entry => !LISTED_BIAS[entry.stance]) || newest[0];
  const broke = exit.product === 'etf-pro' && exit.stance.startsWith('EXIT_') ? 'Trade and/or Trend broke; which is not stated' : 'direction not stated';
  return { value: null, at, basis: 'removed', note: `${said(exit)}: ${values.length ? 'listed both ways' : broke}` };
}
// The time an explicit reading was published; an undated one cannot be shown newer than a listing.
function readingTime(...dates) {
  return dates.map(time).find(Number.isFinite) ?? -Infinity;
}
// Every security alert states each duration; one without verified evidence reads N/A.
// Trade and Trend fall back to RTA / ETF Pro list membership unless an explicit
// reading is at least as new as the latest listing change.
function durationRows(context, symbol, now) {
  const held = (context.holdings?.ruleHoldings || []).find(candidate => symbolOf(candidate.holding) === symbol);
  const decision = context.research?.bySymbol?.[symbol]?.decision || {};
  const listed = listingBias(context.stanceBook, symbol);
  return DURATIONS.map(([field, label]) => {
    let value = null;
    let at = -Infinity;
    if (field === 'tick') {
      const tick = held?.tick;
      value = tick && !invalid(tick) && tick.status === 'published' && dated(tick.publishedAt, now) ? tick.value : null;
    } else if (held && field !== 'tail') {
      value = signalEvidence(held, field, now) ? held[field] : null;
      at = readingTime(held.sources?.[field]?.publishedAt);
    } else {
      const descriptor = decision[field];
      value = descriptor?.status === 'available' && !invalid(descriptor) ? descriptor.value : null;
      at = readingTime(descriptor?.publishedAt, descriptor?.sourceDate);
    }
    // A line broken after the latest reading reads the side the price crossed to.
    const fromListing = listed && ['trade', 'trend'].includes(field) && !(SIGNALS.includes(value) && at >= listed.at);
    // A reading whose Alpha Code line the price has crossed since reads Neutral until reclaimed.
    const broken = ['trade', 'trend'].includes(field)
      && brokenAlphaCodeLine(context.alphaCodeWatch, symbol, field, fromListing ? { value: listed.value, at: listed.at } : { value, at });
    if (broken) return alphaCodeRow(label, broken, fromListing ? listed.value : value);
    if (fromListing) {
      const text = listed.value ? listed.value[0] + listed.value.slice(1).toLowerCase() : 'N/A';
      return { ...row(label, text), basis: listed.basis, note: listed.note };
    }
    return row(label, SIGNALS.includes(value) ? value[0] + value.slice(1).toLowerCase() : 'N/A');
  });
}
// Alpha Code lines are watched by the symbol quoted for them (CL=F for WTI, USO for itself).
const PRICE_DURATIONS = ['trade', 'trend'];
const alphaLines = (watch, symbol) => Object.values(watch?.lines || {}).filter(line => line.symbol === symbol && PRICE_DURATIONS.includes(line.duration));
const priceLineSymbols = watch => [...new Set(Object.values(watch?.lines || {}).filter(line => PRICE_DURATIONS.includes(line.duration)).map(line => line.symbol))];
const level = value => value.toLocaleString('en-US', { maximumFractionDigits: 2 });
const lineLevel = (line, value = line.level) => `${level(value)}${line.unit === '%' ? '%' : ''}`;
// A code printed today or the session before can demand an exit; an older one only notifies.
const FRESH_PRINT_SESSIONS = 1;
// Funds that are the coded market one-for-one: holding one is holding the market. A yield
// line runs opposite to the long-duration fund that tracks it.
const TRACKERS = { 'BZ=F': [['BNO', 1]], '^KS11': [['EWY', 1]], 'DX-Y.NYB': [['UUP', 1]], SILVER: [['SLV', 1]], UST10Y: [['ZROZ', -1]], UST2Y: [['ZROZ', -1]] };
function exposure(context, symbol, verified, now) {
  const own = holdingState(context.holdings, symbol, verified, now);
  if (own.quantity) return { state: own, sign: 1, via: null };
  for (const [ticker, sign] of TRACKERS[symbol] || []) {
    const state = holdingState(context.holdings, ticker, verified, now);
    if (state.quantity) return { state, sign, via: ticker };
  }
  return { state: own, sign: 1, via: null };
}
// Break times read in local Pacific time, 24-hour, with the zone named ("08:14 PST").
const clock = value => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' }).format(new Date(value));
const titled = value => (value ? value[0] + value.slice(1).toLowerCase() : null);
// A watched line's chip: the published call while the price holds its side, Neutral once broken.
function alphaCodeRow(label, line, published = line.reading?.value) {
  const verdict = alphaCodeVerdict(line, published ? { ...line.reading, value: published } : line.reading);
  const where = `Price ${line.side ? `${line.side} ` : 'at '}the ${line.productLabel || 'Alpha Code'} ${label} line ${level(line.level)}`;
  const note = verdict === 'NEUTRAL' && published && published !== 'NEUTRAL'
    ? `${where} since ${clock(line.since)}: the ${titled(published)} ${label} reads Neutral until the price is back on its side; inferred, not stated by the source`
    : `${where}; inferred, not stated by the source`;
  return { ...row(label, titled(verdict) || 'N/A'), basis: 'inferred', note };
}
// A broken Alpha Code line is the Trade or Trend change Hedgeye confirms the next
// morning. One card per instrument states each break; it is red only when the
// line's own security is held on the side the break now opposes.
function alphaCodeFindings(context, now, verified) {
  const watch = context.alphaCodeWatch;
  const output = [];
  for (const symbol of priceLineSymbols(watch)) {
    const lines = alphaLines(watch, symbol).sort((left, right) => left.duration.localeCompare(right.duration));
    const broken = lines.filter(line => line.breaks?.length);
    if (!broken.length) continue;
    const { state, sign, via } = exposure(context, symbol, verified, now);
    const held = state.quantity > 0 ? 'Long' : state.quantity < 0 ? 'Short' : null;
    // A single stock nobody holds is watched for its chips, not announced.
    if (lines[0].scope === 'security' && !held) continue;
    const rows = [...(held ? positionRows(state) : []), ...(via ? [row('Held via', via)] : [])];
    let opposed = null;
    for (const line of broken) {
      const last = line.breaks.at(-1);
      const name = line.duration === 'trade' ? 'Trade' : 'Trend';
      // Every cross of the session, one per line, newest first: the top line is the
      // latest cross and the call it leaves; a reclaim never hides the break before it.
      // A broken line reads its duration Neutral; reclaiming it restores the published call.
      const crosses = line.breaks.map(cross => `${cross.to === 'below' ? 'Broke' : 'Reclaimed'} ${lineLevel(line)} at ${lineLevel(line, cross.price)} (${clock(cross.at)})`).reverse();
      crosses[0] += ` → ${name} ${(alphaCodeVerdict(line) || 'NEUTRAL').toLowerCase()}`;
      rows.push(row(`${name} line`, crosses.join('\n')));
      // Only a fresh print can demand an exit: a line printed days ago still notifies, in blue.
      const printedRecently = sessionsBetween(line.printedDate || line.marketDate, watch.marketDate) <= FRESH_PRINT_SESSIONS;
      if (held && printedRecently && line.side === last.to && (held === 'Long') === ((sign > 0) === (last.to === 'below'))) opposed ||= line;
    }
    if (opposed) {
      const name = opposed.duration === 'trade' ? 'Trade' : 'Trend';
      const cross = opposed.breaks.at(-1);
      rows.push(row('Context', `${opposed.label} broke ${name} ${lineLevel(opposed)} at ${lineLevel(opposed, cross.price)} vs ${held}${via ? ` ${via}` : ''} → ${opposed.duration === 'trade' ? 'exit' : 'reduce to MIN'}.`));
    }
    rows.push(...DURATIONS.map(([field, label]) => {
      const line = lines.find(candidate => candidate.duration === field);
      return line ? alphaCodeRow(label, line) : row(label, 'N/A');
    }));
    const latest = broken.map(line => line.breaks.at(-1).at).sort().at(-1);
    const sourceLinks = broken.map(line => ({ label: `${line.productLabel || 'Research'} Alpha Code`, citation: {
      id: `cite_${hash(['alpha-code', line.symbol, line.duration, line.level, line.marketDate]).slice(0, 28)}`,
      title: `${line.productLabel || 'Research'}: ${line.label} Alpha Code`, product: line.product, publicationDate: line.marketDate,
      ...(line.excerpt ? { excerpt: line.excerpt } : {}), ...emailClip(line.messageId, line.label) } }));
    output.push(finding({ key: [symbol, 'alpha-code-break'], material: [symbol, broken.map(line => [line.duration, line.level, line.breaks.at(-1)])],
      symbol: broken[0].label, kind: opposed ? 'portfolio' : 'market', priority: opposed ? 0 : 1, severity: opposed ? ACTION_REQUIRED : null,
      action: `${broken.map(line => line.duration).join(' and ')} line ${broken.length > 1 ? 'breaks' : 'break'}`, publishedAt: latest, rows, sourceLinks,
      state: held ? state : {} }));
  }
  return output;
}
// A printed code matters on the morning it lands and the session after.
const printedNow = (line, watch) => sessionsBetween(line.printedDate, watch.marketDate) <= FRESH_PRINT_SESSIONS;
const printTime = line => line.publishedAt || `${line.printedDate}T12:00:00Z`;
const lineCitation = (line, title) => ({ label: `${line.productLabel || 'Research'} Alpha Code`, citation: {
  id: `cite_${hash(['level', line.id, line.level, line.printedDate || line.marketDate]).slice(0, 28)}`, title, product: line.product, publicationDate: line.printedDate || line.marketDate,
  ...(line.excerpt ? { excerpt: line.excerpt } : {}), ...emailClip(line.messageId, line.label) } });
// A code printed for the first time in the window, or a printed level moved.
function alphaCodePrintFindings(context, now, verified) {
  const watch = context.alphaCodeWatch;
  const output = [];
  for (const symbol of priceLineSymbols(watch)) {
    const all = alphaLines(watch, symbol).sort((left, right) => left.duration.localeCompare(right.duration));
    const lines = all.filter(line => line.printedDate && printedNow(line, watch) && (line.isNew || line.change));
    if (!lines.length) continue;
    const { state, via } = exposure(context, symbol, verified, now);
    const held = state.quantity > 0 ? 'Long' : state.quantity < 0 ? 'Short' : null;
    if (lines[0].scope === 'security' && !held) continue;
    const named = line => (line.duration === 'trade' ? 'Trade' : 'Trend');
    // The two levels together read as the code; a single printed level has none.
    const code = pick => (all.length === 2 ? ` ${all.sort((left, right) => (left.duration === 'trade' ? -1 : right.duration === 'trade' ? 1 : 0)).map(pick).join('/')}` : '');
    const moved = lines.filter(line => line.change);
    const copy = moved.length
      ? `${lines[0].label} Alpha Code changed.`
      // A lone printed level keeps its Trade/Trend name, since there is no pair to read.
      : `${lines[0].label} Alpha Code${all.length === 2 ? code(line => lineLevel(line)) : ` ${lines.map(line => `${named(line)} ${lineLevel(line)}`).join(', ')}`}.`;
    const codeAt = pick => (all.length === 2 ? code(pick).trim() : moved.map(line => `${named(line)} ${pick(line)}`).join(', '));
    const change = moved.length ? [row('Previous', codeAt(line => lineLevel(line, line.change?.from ?? line.level))), row('New', codeAt(line => lineLevel(line)))] : [];
    const printed = lines[0].printedDate;
    output.push(finding({ key: [symbol, 'alpha-code-print', printed], material: [symbol, printed, lines.map(line => [line.duration, line.level, line.change?.from ?? null])],
      symbol: lines[0].label, kind: 'market', priority: 1, action: moved.length ? 'alpha code changed' : 'new alpha code', publishedAt: printTime(lines[0]),
      rows: [...(held ? positionRows(state) : []), ...(via ? [row('Held via', via)] : []), row('Signal', copy), ...change],
      sourceLinks: lines.map(line => lineCitation(line, `${line.productLabel || 'Research'}: ${line.label} Alpha Code`)), state: held ? state : {} }));
  }
  return output;
}
// One cross per line, newest first, as the Trade and Trend line rows read.
const crossHistory = (line, wording) => line.breaks.map(cross => `${wording(cross)} (${clock(cross.at)})`).reverse().join('\n');
// The SPX flip line and the day's PV bands.
function spxLevelFindings(context) {
  const watch = context.alphaCodeWatch;
  const output = [];
  const lines = Object.values(watch?.lines || {});
  const flip = lines.find(line => line.duration === 'flip');
  if (flip && printedNow(flip, watch) && (flip.isNew || flip.change)) {
    output.push(finding({ key: ['SPX', 'flip-line', flip.printedDate], material: ['SPX', 'flip-line', flip.printedDate, flip.level, flip.change?.from ?? null], symbol: 'SPX', kind: 'market', priority: 1,
      action: flip.change ? 'flip line changed' : 'flip line printed', publishedAt: printTime(flip),
      rows: [row('Signal', flip.change ? `SPX flip line ${level(flip.change.from)} → ${level(flip.level)}.` : `SPX flip line ${level(flip.level)}.`)],
      sourceLinks: [lineCitation(flip, `${flip.productLabel || 'Research'}: SPX flip line`)] }));
  }
  if (flip?.breaks?.length) {
    const last = flip.breaks.at(-1);
    output.push(finding({ key: ['SPX', 'flip-line-cross'], material: ['SPX', 'flip-line-cross', flip.level, last], symbol: 'SPX', kind: 'market', priority: 1, action: 'flip line cross', publishedAt: last.at,
      rows: [row('Signal', last.to === 'below' ? `SPX below flip line ${level(flip.level)} → short gamma: respect breakouts, widen stops.` : `SPX above flip line ${level(flip.level)} → long gamma: fade first touches.`),
        ...(flip.breaks.length > 1 ? [row('Crosses', crossHistory(flip, cross => `${cross.to === 'below' ? 'Below' : 'Above'} ${level(flip.level)} at ${level(cross.price)}`))] : [])],
      sourceLinks: [lineCitation(flip, `${flip.productLabel || 'Research'}: SPX flip line`)] }));
  }
  const gamma = watch?.regime?.tiles?.spxGammaExposure;
  for (const band of lines.filter(line => ['pvUpper', 'pvLower'].includes(line.duration) && line.breaks?.length)) {
    const last = band.breaks.at(-1);
    const name = band.duration === 'pvUpper' ? 'upper' : 'lower';
    const outward = last.to === (band.duration === 'pvUpper' ? 'above' : 'below');
    const stance = gamma === 'Negative' ? ' in short gamma → respect the break' : gamma === 'Positive' ? ' in long gamma → fade the first touch' : '';
    output.push(finding({ key: ['SPX', band.duration, band.marketDate], material: ['SPX', band.duration, band.level, last], symbol: 'SPX', kind: 'market', priority: 1, action: 'pv band cross', publishedAt: last.at,
      rows: [row('Signal', outward ? `SPX through ${name} PV band ${level(band.level)}${stance}.` : `SPX back inside ${name} PV band ${level(band.level)}.`)],
      sourceLinks: [lineCitation(band, 'Market Structure: SPX PV bands')] }));
  }
  return output;
}
// Low / Moderate / High, the same regime names as the VIX bucket table.
const VOL_REGIME_BY_NAME = { Investable: 'Low', Chop: 'Moderate', 'F Bucket': 'High' };
const volRegime = bucket => bucket.regime || VOL_REGIME_BY_NAME[bucket.name] || bucket.name;
// The VIX bucket lines, from the same bucket table the rest of the site reads.
function vixFindings(context) {
  const lines = Object.values(context.alphaCodeWatch?.lines || {}).filter(line => line.duration === 'vix' && line.breaks?.length);
  if (!lines.length) return [];
  const crosses = lines.flatMap(line => line.breaks.map(cross => ({ ...cross, line }))).sort((left, right) => left.at.localeCompare(right.at));
  const last = crosses.at(-1);
  const bucket = last.to === 'above' ? last.line.above : last.line.below;
  return [finding({ key: ['VIX', 'bucket-cross'], material: ['VIX', 'bucket-cross', last.line.level, last.to, last.at], symbol: 'VIX', kind: 'market', priority: 1, action: 'vix bucket cross', publishedAt: last.at,
    rows: [row('Signal', `VIX ${last.to === 'above' ? '≥' : '<'} ${level(last.line.level)} → ${volRegime(bucket)} Volatility Regime.`)], sourceLinks: [] })];
}
// The book's direction by weight, or by position count while weights are unavailable. Holdings
// need not be current for this: a Risk Off call should not wait for a broker reconnect.
function netLong(book) {
  const weighted = (book?.currentHoldings || []).filter(item => number(item.quantity) && number(item.currentHolding?.weightPct) !== null);
  if (weighted.length) return weighted.reduce((sum, item) => sum + Math.sign(item.quantity) * item.currentHolding.weightPct, 0) > 0;
  const positions = (book?.positions || []).filter(position => position.category !== 'event_contract' && number(position.quantity));
  return positions.length ? positions.reduce((sum, position) => sum + Math.sign(position.quantity), 0) > 0 : null;
}
const REGIME_ACTIONS = {
  spxGammaExposure: { subject: 'SPX', name: 'SPX gamma', to: { Negative: 'wider ranges; respect breakouts', Positive: 'tighter ranges; fade first touches' } },
  systematicFlowRisk: { subject: 'SPX', name: 'Systematic flow', to: { Bearish: 'expect selling on breakdowns', Bullish: 'expect buying on breakouts' } },
  pvBandRiskReward: { subject: 'SPX', name: 'PV band risk/reward', to: {} },
  strategicAllocation: { subject: 'Market', name: 'Strategic Allocation', to: { 'Risk Off': 'cut gross', 'Risk On': 'tighter stops' } },
};
const GAMMA_READ = {
  Negative: { sign: -1, text: 'Below 0, dealers hedge with the move, which widens swings both ways. Further below 0 is stronger. It says volatility, not direction.' },
  Positive: { sign: 1, text: 'Above 0, dealers hedge against the move, which narrows swings. Further above 0 is stronger. It says volatility, not direction.' },
};
const MIN_THROTTLE_HISTORY = 10;
// How unusual the reading is against the stored editions; too few editions say nothing.
function throttleRank(value, history) {
  if (!(history?.values?.length >= MIN_THROTTLE_HISTORY)) return null;
  const { values, since } = history;
  const span = `readings since ${monthDay(since)}`;
  if (value < Math.min(...values)) return `lowest of ${values.length + 1} ${span}; prior low ${Math.min(...values).toFixed(2)}`;
  if (value > Math.max(...values)) return `highest of ${values.length + 1} ${span}; prior high ${Math.max(...values).toFixed(2)}`;
  return value < 0 ? `more negative than ${values.filter(item => item > value).length} of the prior ${values.length} ${span}`
    : `higher than ${values.filter(item => item < value).length} of the prior ${values.length} ${span}`;
}
// One standard deviation of a day's move implied by the annualized 10-day figure.
function realizedRow(regime) {
  const realized = number(regime.realizedVolatility);
  if (realized === null) return [];
  const daily = realized / Math.sqrt(252);
  const price = number(regime.spxPrice);
  return [row('10-day realized', `${level(realized)}% ÷ √252 ≈ ${daily.toFixed(1)}% a day${price ? `, about ${Math.round(price * daily / 100).toLocaleString('en-US')} SPX points` : ''}.`)];
}
function gammaRows(regime, to) {
  const value = number(regime.gammaThrottle);
  if (value === null) return [];
  const read = GAMMA_READ[to];
  return [row('Gamma throttle', [value.toFixed(2), throttleRank(value, regime.throttleHistory)].filter(Boolean).join(' · ')),
    ...(read && Math.sign(value) === read.sign ? [row('What it means', read.text)] : []), ...realizedRow(regime)];
}
// What the newest Market Structure edition changed, all blue notifications. Risk Off against a
// net long book stays up for as long as the tile reads Risk Off, until dismissed.
function regimeFindings(context) {
  const watch = context.alphaCodeWatch;
  const regime = watch?.regime;
  if (!regime?.date) return [];
  const output = [];
  const publishedAt = regime.publishedAt || `${regime.date}T12:00:00Z`;
  const card = (tile, from, to, date) => {
    const words = REGIME_ACTIONS[tile];
    const action = words.to[to];
    return finding({ key: ['market-regime', tile, date, 'note'], material: ['market-regime', tile, date, from, to], symbol: words.subject,
      kind: 'market', priority: 1, severity: null, action: `${words.name.toLowerCase()} change`, publishedAt,
      rows: [row('Signal', `${words.name} ${from} → ${to}${action ? ` → ${action}` : ''}.`),
        ...(tile === 'spxGammaExposure' ? gammaRows(regime, to) : [])],
      sourceLinks: [{ label: 'Market Structure', citation: { id: `cite_${hash(['market-regime', tile, date]).slice(0, 28)}`, title: `Market Structure: ${words.name}`, product: 'market-structure', publicationDate: date, excerpt: `${words.name}: ${to}`, ...emailClip(regime.messageId, 'SPX'), ...(regime.chartUrl ? { sourceImageUrl: regime.chartUrl } : {}) } }] });
  };
  const standing = regime.riskOff && regime.tiles?.strategicAllocation === 'Risk Off' && netLong(context.holdings) === true;
  if (standing) output.push(card('strategicAllocation', regime.riskOff.from, 'Risk Off', regime.riskOff.since));
  if (sessionsBetween(regime.date, watch.marketDate) > FRESH_PRINT_SESSIONS) return output;
  for (const change of regime.changes || []) {
    if (!REGIME_ACTIONS[change.id] || (standing && change.id === 'strategicAllocation')) continue;
    output.push(card(change.id, change.from, change.to, regime.date));
  }
  return output;
}
function portfolioFindings(context, now, verified) {
  if (!verified) return [];
  const book = context.holdings;
  const output = [];
  for (const candidate of book.ruleHoldings || []) {
    const symbol = symbolOf(candidate.holding);
    const state = holdingState(book, symbol, true, now);
    if (!state.quantity || (state.quantity > 0 ? 'LONG' : 'SHORT') !== candidate.heldSide || invalid(candidate)) continue;
    const holding = { ...candidate, weightPct: state.currentHolding?.weightPct ?? null };
    for (const field of ['trade', 'trend']) if (!signalEvidence(candidate, field, now)) holding[field] = null;
    const rule = evaluatePortfolioRule(holding, book.asOf);
    if (rule.status !== 'conflict') continue;
    const field = rule.rule === 'TRADE_BREAK' ? 'trade' : 'trend';
    let publishedAt = candidate.sources?.[field]?.publishedAt;
    const sizingRule = ['RISK_CAP', 'ABOVE_MAX'].includes(rule.rule);
    // A sizing limit is the dashboard's own calculation; a published Trade or Trend is not what raised it.
    const sources = sizingRule ? [] : ['trade', 'trend'].filter(key => signalEvidence(candidate, key, now)).map(key => ({ label: `${key === 'trade' ? 'Trade' : 'Trend'} source`, citation: candidate.sources[key].citation }));
    if (sizingRule) {
      // Only ATR and the reference close size a position; a captured beta is not evidence.
      const metrics = Object.entries(candidate.sizingInputs || {}).filter(([key, value]) => ['atr14', 'referencePrice'].includes(key) && value && !invalid(value) && dated(value.asOf, now) && value.source && number(value.value) !== null);
      publishedAt = metrics.map(([, value]) => value.asOf).sort().at(-1);
      for (const [metric, value] of metrics) sources.push({ label: `${metric} evidence`, citation: { id: `cite_${hash([symbol, metric, value.source, value.asOf]).slice(0, 28)}`,
        title: `${symbol} ${metric}`, product: 'process-sizing', publicationDate: String(value.asOf).slice(0, 10), sourceUri: `/api/security-risk-metrics?symbols=${encodeURIComponent(symbol)}&sizingOnly=1`, excerpt: `${metric}: ${value.value}. Source: ${value.source}. Observed: ${value.asOf}.` } });
    }
    if (!sources.length || !publishedAt) continue;
    const side = candidate.heldSide === 'LONG' ? 'Long' : 'Short';
    let explanation;
    if (rule.rule === 'TRADE_BREAK') explanation = `Trade turned ${rule.trade[0]}${rule.trade.slice(1).toLowerCase()} vs ${side} → exit.`;
    else if (rule.rule === 'TREND_BREAK') explanation = 'Trend broke → reduce to MIN.';
    else if (rule.rule === 'RISK_CAP') explanation = 'Too volatile to size → exit.';
    else explanation = 'Above MAX → trim to MAX.';
    const target = rule.action === 'REDUCE' && number(rule.targetWeight) !== null ? rule.targetWeight : null;
    const order = orderText(state.quantity, rule.action === 'EXIT' ? 0 : target !== null && rule.weightPct > 0 ? target / rule.weightPct : null);
    const rows = [...positionRows(state), ...processLimitRows(rule),
      row('Action', rule.action === 'EXIT' ? `Exit ${side}` : target !== null ? `Reduce to ${rule.targetLabel} ${pct(target)}` : 'Reduce size'),
      // The trim is measured from the holding weight, so it is shown only while holdings are current.
      ...(target !== null && number(rule.weightPct) !== null && number(rule.reduction) !== null
        ? [{ ...row('Trim', `${rule.reduction.toFixed(2)} pts (${pct(rule.weightPct)} → ${pct(target)})`), requiresFreshHoldings: true }] : []),
      ...(order ? [{ ...row('Order', order), requiresFreshHoldings: true }] : []),
      row('Context', explanation)];
    rows.push(...durationRows(context, symbol, now));
    // A published Trade or Trend against the held side contradicts the position.
    // Risk-cap and MAX breaches are sizing reviews, not a contrary source.
    const severity = ['TRADE_BREAK', 'TREND_BREAK'].includes(rule.rule) ? ACTION_REQUIRED : null;
    output.push(finding({ key: [symbol, candidate.heldSide, 'portfolio-rule'], material: [symbol, candidate.heldSide, rule.rule, rule.action, rule.trade, rule.trend],
      symbol, kind: 'portfolio', priority: 0, severity, action: rule.action.toLowerCase(), publishedAt, rows, sourceLinks: sources, state: { ...state, rule: { rule: rule.rule, action: rule.action, status: rule.status } } }));
  }
  return output;
}
const ACTIONS = { SELL: ['Long', 'Sell'], 'SELL-SOME': ['Long', 'Sell some'], 'SELL-PARTIAL': ['Long', 'Sell some'], TRIM: ['Long', 'Sell some'], REDUCE: ['Long', 'Reduce'], EXIT: ['Long', 'Exit'], 'SELL-ALL': ['Long', 'Sell all'], COVER: ['Short', 'Cover'], 'COVER-SOME': ['Short', 'Cover some'], 'COVER-SHORT': ['Short', 'Cover'], 'BUY-TO-COVER': ['Short', 'Cover'] };
const SIDES = { LONG: 'Long', SHORT: 'Short' };
// New positions name the side they establish; a typed ADD carries its own side.
const OPENS = { ADD: null, BUY: 'Long', 'BUY-SOME': 'Long', 'INITIATE-LONG': 'Long', SHORT: 'Short', 'SHORT-SELL': 'Short', 'SELL-SHORT': 'Short', 'INITIATE-SHORT': 'Short', 'ADD-SHORT': 'Short' };
// Roster removals and side-typed position changes are complete instructions, so
// unlike a generic Sell headline they need no report prose to establish scope.
function typedChange(event, evidence) {
  if (event.eventType === 'signal_strength_removed') return { action: 'REMOVE', side: 'Long' }; // The main list is bullish signals only.
  // Signal Strength Shorts (since 2026-10-15) is its own bearish list.
  if (event.eventType === 'signal_strength_short_added') return { action: 'OPEN', side: 'Short' };
  if (event.eventType === 'signal_strength_short_removed') return { action: 'REMOVE', side: 'Short' };
  let source = {};
  try {
    const parsed = JSON.parse(event.excerpt);
    if (parsed && !Array.isArray(parsed) && symbolOf(parsed.ticker || parsed.symbol) === symbolOf(event.entityId)) source = parsed;
  } catch { /* A headline excerpt carries no typed side. */ }
  const side = SIDES[String(event.positionSide || source.side || source.positionSide || '').trim().toUpperCase()] || null;
  if (['REMOVE', 'ROSTER-REMOVAL'].includes(evidence.action)) return { action: 'REMOVE', side };
  if (!Object.hasOwn(OPENS, evidence.action)) return null;
  const opened = OPENS[evidence.action] || side;
  return opened ? { action: 'OPEN', side: opened } : null;
}
// A removal without a stated side still applies to whichever side is held:
// a missed exit costs more than a removal reviewed and kept.
const contradicts = (change, held) => change.action === 'REMOVE' ? !change.side || change.side === held : change.side !== held;
function sourceInstruction(event, now) {
  if (event.qualityStatus !== 'validated' || invalid(event) || !dated(event.publishedAt, now)
    || !event.sourceMessageId || !['security', 'ticker', 'equity', 'etf'].includes(String(event.entityType).toLowerCase())) return null;
  const evidence = sourceActionEvidence(event);
  const exit = ACTIONS[evidence.action] || null;
  const change = exit ? null : typedChange(event, evidence);
  if (!exit && !change) return null;
  const actionKey = exit ? evidence.action : change.action === 'REMOVE' ? 'REMOVE' : `OPEN-${change.side.toUpperCase()}`;
  return { symbol: symbolOf(event.entityId), event, evidence, exit, change, actionKey };
}
function publishedRange(event) {
  const value = event.riskRange || (event.value && typeof event.value === 'object' ? event.value : {});
  const low = Number(value.lrr ?? value.riskRangeLow);
  const high = Number(value.hrr ?? value.riskRangeHigh);
  return Number.isFinite(low) && Number.isFinite(high) && low > 0 && low < high ? `${low}–${high}` : null;
}
// Exits and removals published while holdings could not be read wait for the
// Analyst's own holdings check, even after the market date rolls over.
const PENDING_CHECK_STATES = ['resolved', 'superseded'];
function awaitingHoldingsCheck(context) {
  const awaiting = new Set();
  for (const item of context.previousAttention || []) {
    const pending = item.pendingHoldingsCheck;
    if (!pending || PENDING_CHECK_STATES.includes(item.state)) continue;
    for (const symbol of pending.symbols || []) awaiting.add(`${pending.marketDate}\u0000${symbol}`);
  }
  return awaiting;
}
// A product followed in one account is checked against that account's own book (from the
// IBKR activity statement, dated), never the live Gateway book of another account.
function accountState(book, symbol) {
  const quantity = (book.positions || []).filter(position => symbolOf(position.symbol) === symbol).reduce((sum, position) => sum + position.quantity, 0);
  return { holdingsVerified: true, holdingsVerifiedAt: book.fetchedAt || book.asOf, quantity, currentHolding: null, account: book.account };
}
const shortDate = value => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${String(value).slice(0, 10)}T12:00:00Z`));
function sourceActionFindings(context, now, verified, conflicts, sentenceMemo) {
  const awaiting = awaitingHoldingsCheck(context);
  // The latest instruction per security and product decides; a later re-add
  // from the same product supersedes its earlier removal.
  const latest = new Map();
  for (const event of context.events || []) {
    // Signal Strength, ETF Pro and Real-Time Alerts are standing stances in the stance book.
    if (STANCE_PRODUCTS.has(event.productKey)) continue;
    const instruction = sourceInstruction(event, now);
    // A generic alert headline cannot establish full versus partial action.
    // Require its exact report body/subject or an explicit partial typed action.
    if (!instruction || (instruction.exit && !instruction.evidence.report)) continue;
    const { symbol, actionKey } = instruction;
    const conditionId = `attention:portfolio:${hash([symbol, 'source-action', event.productKey, actionKey]).slice(0, 28)}`;
    const existing = (context.previousAttention || []).find(item => item.id === conditionId && !['resolved', 'superseded'].includes(item.state));
    const date = String(event.marketDate || event.publishedAt).slice(0, 10);
    if (date !== context.marketDate && !existing && !awaiting.has(`${date}\u0000${symbol}`)) continue;
    const slot = `${symbol}\u0000${event.productKey}`;
    const previous = latest.get(slot);
    if (!previous || time(previous.event.publishedAt) < time(event.publishedAt)) latest.set(slot, instruction);
  }
  const output = [];
  for (const { symbol, event, evidence, exit, change, actionKey } of latest.values()) {
    // Only a red Trade/Trend break replaces a source instruction; a sizing review never hides one.
    const scoped = PRODUCT_ACCOUNTS[event.productKey];
    const accountBook = scoped ? context.accountBooks?.[event.productKey] : null;
    // An account-scoped product waits for that account's book; every other product for the live book.
    if (scoped ? !(accountBook && Array.isArray(accountBook.positions) && accountBook.asOf) : !verified) continue;
    if (!scoped && conflicts.some(item => item.symbol === symbol && item.severity === ACTION_REQUIRED)) continue;
    const state = scoped ? accountState(accountBook, symbol) : holdingState(context.holdings, symbol, true, now);
    // An account that follows the product mirrors its adds too: a blue Action to open the position
    // until that account's statement shows it held on the published side.
    if (scoped && change?.action === 'OPEN' && change.side && Math.sign(state.quantity) !== (change.side === 'Long' ? 1 : -1)) {
      const product = event.productLabel || 'The source';
      const openRows = [row('Action', `${product} added ${symbol} (${change.side}) → buy ${change.side}`), row('Account', scoped),
        row('Account position', state.quantity ? `${state.quantity > 0 ? 'Long' : 'Short'} (as of ${shortDate(accountBook.asOf)})` : `Not held (as of ${shortDate(accountBook.asOf)})`)];
      const range = publishedRange(event);
      if (range) openRows.push(row('Published range', range));
      openRows.push(...durationRows(context, symbol, now));
      const citation = { id: evidence.report?.citationId || `cite_${hash(event.sourceMessageId).slice(0, 24)}`, title: evidence.report?.title || event.productLabel,
        product: event.productKey, publicationDate: event.marketDate, sourceUri: event.sourceUrl || `gmail://message/${event.sourceMessageId}`,
        excerpt: evidence.report?.bodyText || event.excerpt, ...emailClip(event.sourceMessageId, symbol) };
      output.push(finding({ key: [symbol, 'source-action', event.productKey, actionKey], material: [actionKey, change.side, range, accountBook.asOf],
        symbol, kind: 'opportunity', priority: 1, action: 'add', publishedAt: event.publishedAt, rows: openRows,
        sourceLinks: [{ label: event.productLabel || 'Source', citation }], state: { ...state, event } }));
      continue;
    }
    if (!state.quantity) continue;
    const held = state.quantity > 0 ? 'Long' : 'Short';
    if (exit ? exit[0] !== held : !contradicts(change, held)) continue;
    const partial = exit && /some|Reduce/.test(exit[1]);
    const directive = evidence.instruction || '';
    const contextLines = describeAnalystFinding({ event, ...state }, [], now.getTime(), sentenceMemo).sourceContext || [];
    if (exit && !contextLines.length) continue;
    if (partial && number(event.targetQuantity) !== null && Math.abs(state.quantity) <= Math.abs(event.targetQuantity)) continue;
    const product = event.productLabel || 'The source';
    const actionText = exit ? `${exit[1]} → review ${exit[0]}`
      : change.action === 'REMOVE' ? `${product} removed ${symbol}${change.side ? ` (${change.side})` : ' (side unstated)'} → exit ${held}`
        : `${product} went ${change.side} vs your ${held} → review`;
    const range = publishedRange(event);
    const headline = text(event.excerpt).startsWith('{') ? '' : text(event.excerpt);
    // Go-Anywhere is followed only in the Roth IRA, so its cards name that account first, under Ticker.
    // The account's position is dated: its statement runs a business day or two behind.
    const rows = [...(scoped ? [row('Account', scoped), row('Account position', `${held} (as of ${shortDate(accountBook.asOf)})`)] : positionRows(state)),
      row('Action', actionText)];
    if (range) rows.push(row('Published range', range));
    if (contextLines.length || headline) rows.push(row('Context', contextLines.length ? contextLines.join(' ') : headline));
    rows.push(...durationRows(context, symbol, now));
    const citation = { id: evidence.report?.citationId || `cite_${hash(event.sourceMessageId).slice(0, 24)}`, title: evidence.report?.title || event.productLabel,
      product: event.productKey, publicationDate: event.marketDate, sourceUri: event.sourceUrl || `gmail://message/${event.sourceMessageId}`,
      excerpt: directive || evidence.report?.bodyText || event.excerpt, ...emailClip(event.sourceMessageId, symbol) };
    output.push(finding({ key: [symbol, 'source-action', event.productKey, actionKey],
      material: exit ? [evidence.action, text(directive), contextLines] : [actionKey, change.side, range, headline],
      symbol, kind: 'portfolio', priority: 0, severity: ACTION_REQUIRED, action: exit ? evidence.action.toLowerCase() : change.action === 'REMOVE' ? 'remove' : 'opposing position',
      publishedAt: event.publishedAt, rows, sourceLinks: [{ label: event.productLabel || 'Source', citation }], state: { ...state, event } }));
  }
  output.push(...publishedBookFindings(context, now, new Set(output.map(item => `${item.event?.productKey}\u0000${item.symbol}`))));
  return output;
}
// The account follows the product's whole published list, not only the day's changes: every
// listed ETF the account does not hold on its side is a blue Action to buy it. Today's adds
// already have their own card. A held ETF the list no longer names is left alone (it may be cash).
function publishedBookFindings(context, now, covered) {
  const output = [];
  for (const [productKey, account] of Object.entries(PRODUCT_ACCOUNTS)) {
    const book = context.accountBooks?.[productKey];
    if (!book?.published?.rows || !Array.isArray(book.positions) || !book.asOf) continue;
    const label = context.productLabels?.[productKey] || PRODUCT_LABELS[productKey] || productKey;
    for (const listed of book.published.rows) {
      const symbol = symbolOf(listed.ticker);
      if (!symbol || covered.has(`${productKey}\u0000${symbol}`)) continue;
      const state = accountState(book, symbol);
      if (Math.sign(state.quantity) === (listed.side === 'Long' ? 1 : -1)) continue;
      const rows = [row('Action', `${label} holds ${symbol} (${listed.side}) → buy ${listed.side}`), row('Account', account),
        row('Account position', state.quantity ? `${state.quantity > 0 ? 'Long' : 'Short'} (as of ${shortDate(book.asOf)})` : `Not held (as of ${shortDate(book.asOf)})`),
        ...(listed.dateAdded ? [row('In the book since', shortDate(listed.dateAdded))] : []), ...durationRows(context, symbol, now)];
      const messageId = book.published.messageId;
      const citation = { id: `cite_${hash([productKey, book.published.date, symbol]).slice(0, 24)}`, title: label, product: productKey,
        publicationDate: book.published.date, sourceUri: messageId ? `gmail://message/${messageId}` : null, excerpt: `${listed.etf || symbol} · ${listed.side}`,
        ...(messageId ? emailClip(messageId, symbol) : {}) };
      const event = { productKey, productLabel: label, marketDate: book.published.date, publishedAt: `${book.published.date}T12:00:00Z`, sourceMessageId: messageId };
      output.push(finding({ key: [symbol, 'published-book', productKey, listed.side], material: [listed.side, book.published.date, book.asOf, state.quantity],
        symbol, kind: 'opportunity', priority: 1, action: 'add', publishedAt: event.publishedAt, rows,
        sourceLinks: [{ label, citation }], state: { ...state, event } }));
    }
  }
  return output;
}
const PRODUCT_LABELS = { 'go-anywhere': 'Go-Anywhere Portfolio' };
// Products whose calls apply to one account only.
const PRODUCT_ACCOUNTS = { 'go-anywhere': 'Roth IRA' };
// Without verified holdings, today's exits and removals cannot be matched to the
// book. An Alert needs a position the Analyst confirmed, so this is only a
// notice that the check is waiting; the user is never asked to confirm holdings.
// It resolves when a verified scan completes, and those symbols are not raised
// again for the same date when holdings drop out later.
function pendingCheckFindings(context, now, verified) {
  if (verified || !context.marketDate) return [];
  const key = ['unverified-instructions', context.marketDate];
  const previous = (context.previousAttention || []).find(item => item.id === `attention:operational:${hash(key).slice(0, 28)}`);
  // A resolved notice from before pendingHoldingsCheck was recorded was checked in full.
  if (previous?.state === 'resolved' && !previous.pendingHoldingsCheck) return [];
  const recorded = previous?.pendingHoldingsCheck || {};
  const checked = new Set([...(recorded.checked || []), ...(previous?.state === 'resolved' ? recorded.symbols || [] : [])]);
  const pending = new Map();
  for (const event of context.events || []) {
    const instruction = sourceInstruction(event, now);
    if (!instruction || instruction.change?.action === 'OPEN' || checked.has(instruction.symbol)
      || String(event.marketDate || event.publishedAt).slice(0, 10) !== context.marketDate) continue;
    if (!pending.has(instruction.symbol)) pending.set(instruction.symbol, instruction);
  }
  if (!pending.size) return [];
  const symbols = [...pending.keys()].sort();
  const events = [...pending.values()].map(item => item.event);
  const publishedAt = events.map(event => event.publishedAt).sort((a, b) => time(a) - time(b)).at(-1);
  const sourceLinks = events.map(event => ({ label: event.productLabel || 'Source', citation: { id: `cite_${hash(event.sourceMessageId).slice(0, 24)}`, title: event.productLabel,
    product: event.productKey, publicationDate: event.marketDate, sourceUri: event.sourceUrl || `gmail://message/${event.sourceMessageId}`, excerpt: event.excerpt,
    ...emailClip(event.sourceMessageId, symbolOf(event.entityId)) } }));
  return [finding({ key, material: symbols, symbol: 'Holdings check', kind: 'operational', action: 'pending holdings check', publishedAt, sourceLinks,
    state: { assessmentChannel: 'research', pendingHoldingsCheck: { marketDate: context.marketDate, symbols, checked: [...checked].sort() } },
    rows: [row('Pending', symbols.join(', ')),
      row('Context', 'Exit/removal published, IB Gateway holdings unreadable → Analyst checks when holdings return.')] })];
}
const DIRECT = new Set(['direct', 'direct_alias']);
const validReference = (reference, now) => reference && !invalid(reference) && reference.qualityStatus === 'indexed' && DIRECT.has(reference.matchType) && dated(reference.publishedAt || reference.marketDate, now) && reference.sourceUrl;
function citationFor(reference) {
  return { id: `cite_${hash([reference.productId, reference.sourceUrl, reference.marketDate, reference.excerpt]).slice(0, 32)}`,
    title: reference.productLabel || reference.productId, product: reference.productId, publicationDate: reference.marketDate, sourceUri: reference.sourceUrl, excerpt: reference.excerpt };
}
function direction(reference) {
  if (!['position_change', 'position_mention', 'position_reference', 'etf_pro_change', 'investing_idea_position', 'real_time_alert'].includes(reference.kind)) return null;
  let value = reference.value;
  try { value = JSON.parse(reference.excerpt); } catch { /* Structured value may already be present. */ }
  const raw = String((value && typeof value === 'object' ? value.side || value.call || value.action : value) || reference.direction || '').toUpperCase();
  if (['LONG', 'BUY', 'ADD', 'BUY-SOME', 'INITIATE-LONG'].includes(raw)) return 'Long';
  if (['SHORT', 'SHORT-SELL', 'SELL-SHORT', 'INITIATE-SHORT', 'ADD-SHORT'].includes(raw)) return 'Short';
  return null;
}
const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
function sentences(value, sentenceMemo) {
  if (typeof value !== 'string' || value.trim().startsWith('{') || value.trim().startsWith('[')) return [];
  if (sentenceMemo.has(value)) return sentenceMemo.get(value);
  const result = value.split(/\r?\n+/).flatMap(line => [...segmenter.segment(line)].map(part => text(part.segment).replace(/^[•*-]\s*/, '')))
    .filter(line => line.length >= 35 && line.length <= 620 && !/[{}]|\\[nrtu"]|"\s*[:,\]]|https?:\/\/|\b(?:copyright|subscribe|unsubscribe|disclaimer)\b/i.test(line));
  sentenceMemo.set(value, result);
  return result;
}
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (value, symbol) => new RegExp(`(^|[^A-Za-z0-9])${escape(symbol)}(?=$|[^A-Za-z0-9])`, 'i').test(value);
const timely = value => /\b(?:new(?:ly)?|initiat\w*|add(?:ed|ing)?|accelerat\w*|decelerat\w*|deteriorat\w*|improv\w*|turn(?:ed|ing)|flip(?:ped)?|break(?:ing|out)?|broke|catalyst|earnings|inflect\w*|shift\w*|transition\w*|revers\w*|tighten\w*|narrow\w*|rebound\w*|raising|lowering)\b/i.test(value);
const thesis = value => /\b(?:because|due to|driven by|while|despite|given|reflect|benefit|pressure|demand|supply|growth|inflation|earnings|cash flow|valuation|momentum|liquidity|yields?|rates?|dollar|quad[1-4]?|beta|volatility|gamma|WTI|backwardated)\b/i.test(value);
function securityPassage(value, symbol) {
  const forward = new RegExp(`(^|[^A-Za-z0-9])(${escape(symbol)}\\s*\\([^)]{2,70}\\))`).exec(value);
  if (forward) {
    const start = forward.index + forward[1].length;
    const next = /,?\s+and\s+[A-Z][A-Z0-9]{1,5}\s*\([^)]{2,70}\)/.exec(value.slice(start + forward[2].length));
    return next ? value.slice(start, start + forward[2].length + next.index).trim().replace(/,$/, '') : value.slice(start);
  }
  // A roster is insufficient even when its surrounding macro paragraph is
  // substantive. Require a direct subject or named-security sentence.
  return new RegExp(`^(?:\\([^)]*\\)\\s*)?(?:${escape(symbol)}\\b|.{0,90}\\(${escape(symbol)}\\))`).test(value)
    ? value.split(/\balongside\b/i)[0].trim().replace(/[ ,]+$/, '') : null;
}
function passages(context, reference, symbol, sentenceMemo) {
  const result = [];
  const product = (context.documents?.products || []).find(item => item.product === reference.productId && item.publicationDate === reference.marketDate);
  for (const fragment of product?.excerpts || []) {
    const citation = fragment.citation;
    if (!linked(citation)) continue;
    // The reference URL must be visible in the exact document or be its URI.
    // Product/date alone cannot identify one of several same-day editions.
    const doc = product.documents?.find(item => item.documentId === citation.documentId);
    const sameDocument = citation.sourceUri === reference.sourceUrl || doc?.sourceUri === reference.sourceUrl
      || (product.excerpts || []).some(other => other.citation?.documentId === citation.documentId && String(other.excerpt).includes(reference.sourceUrl));
    if (!sameDocument) continue;
    for (const line of sentences(fragment.excerpt, sentenceMemo)) if (mentions(line, symbol)) result.push({ text: line, citation });
  }
  // Direct indexed references are exact evidence too, but truncated fragments
  // cannot become a manufactured complete thesis sentence.
  for (const line of sentences(reference.excerpt, sentenceMemo)) if (mentions(line, symbol) && !line.includes('…')) result.push({ text: line, citation: citationFor(reference) });
  return result;
}
function thesisWatch(value, side) {
  const checks = [
    [/\b(?:bond[- ]market volatility|rate[- ]volatility)\b/i, 'Bond vol fades → volatility case weakens.'],
    [/\b(?:oil-cost|airlines)\b/i, 'Airline oil costs ease → Short case weakens.'],
    [/\b(?:deteriorating local Quad|cyclicals)\b/i, 'Local Quad and cyclicals recover → case weakens.'],
    [/\b(?:Financials and Discretionary)\b/i, 'Financials and Discretionary lead again → Short case weakens.'],
    [/\b(?:higher rates|tightening subsidy)\b/i, 'Rate or subsidy pressure eases → Short case weakens.'],
    [/\b(?:earnings|demand)\b/i, `Next earnings/demand update confirms → ${side} case holds.`],
    [/\b(?:long.duration|momentum (?:breaks|unwind))\b/i, 'Momentum recovers or rate pressure eases → Short case weakens.'],
    [/\b(?:WTI|energy|oil)\b/i, 'Next Trade/Trend still aligned → oil/energy case holds.'],
  ];
  return checks.find(([pattern]) => pattern.test(value))?.[1] || null;
}
function opportunityFindings(context, now, verified, conflicts, sentenceMemo) {
  const output = [];
  for (const [rawSymbol, security] of Object.entries(context.research?.bySymbol || {})) {
    const symbol = symbolOf(rawSymbol);
    if (!/^[A-Z0-9.\-^]{1,24}$/.test(symbol) || conflicts.some(item => item.symbol === symbol)) continue;
    const state = holdingState(context.holdings || {}, symbol, verified, now);
    const references = (security.directReferences || []).filter(reference => validReference(reference, now) && reference.marketDate === context.marketDate);
    const candidates = [];
    for (const reference of references) {
      const side = direction(reference);
      if (!side) continue;
      const peers = references.filter(peer => peer.productId === reference.productId && peer.sourceUrl === reference.sourceUrl);
      const caseRows = peers.flatMap(peer => passages(context, peer, symbol, sentenceMemo)).map(passage => ({ ...passage, text: securityPassage(passage.text, symbol) }))
        .filter(passage => passage.text && timely(passage.text) && thesis(passage.text));
      if (!caseRows.length) continue;
      // A source that describes a reduction or exit is not an add/new idea.
      const selected = caseRows.find(passage => !/\b(?:exit(?:ed|ing)?|sell(?:ing)?[ -]some|cover(?:ed|ing)?|reduc(?:ed|ing)|below minimum)\b/i.test(passage.text));
      if (selected) candidates.push({ reference, side, selected });
    }
    if (!candidates.length) continue;
    candidates.sort((a, b) => time(b.reference.publishedAt) - time(a.reference.publishedAt));
    const candidate = candidates[0];
    if (candidates.some(other => time(other.reference.publishedAt) === time(candidate.reference.publishedAt) && other.side !== candidate.side)) continue;
    const { reference, side, selected } = candidate;
    // An aligned source roster is confirmation, not a reason to revisit an
    // existing holding. Require an explicit new allocation/add catalyst there.
    if (state.quantity && (state.quantity > 0 ? 'Long' : 'Short') === side
      && !/\b(?:new (?:allocation|asset allocation)|initiat\w*|start(?:ed|ing) (?:buying|shorting)|adding|buying)\b/i.test(selected.text)) continue;
    const watchText = thesisWatch(selected.text, side);
    if (!watchText) continue;
    // Held ideas need a specific constructive catalyst too; opposite-side
    // proposals are reviewed as research, never silently converted to exits.
    const label = state.holdingsVerified && state.quantity ? `Review ${side} case` : `New ${side} idea → review`;
    const rows = [...positionRows(state), row('Action', label), row('Context', selected.text)];
    const sources = [{ label: reference.productLabel || 'Research source', citation: selected.citation }];
    const contrary = [];
    for (const field of ['trade', 'trend']) {
      const descriptor = security.decision?.[field];
      if (descriptor?.status !== 'available' || !['BULLISH', 'BEARISH', 'NEUTRAL'].includes(descriptor.value) || invalid(descriptor)) continue;
      const source = references.find(peer => peer.productId === descriptor.sourceId && (field === 'trade' ? ['trade_signal', 'tracker_trade'].includes(peer.kind) : ['primary_risk_range', 'trend_signal'].includes(peer.kind)));
      if (!source) continue;
      sources.push({ label: `${field === 'trade' ? 'Trade' : 'Trend'} source`, citation: citationFor(source) });
      if (descriptor.value !== (side === 'Long' ? 'BULLISH' : 'BEARISH')) contrary.push(`${field === 'trade' ? 'Trade' : 'Trend'} is ${descriptor.value[0]}${descriptor.value.slice(1).toLowerCase()}`);
    }
    rows.push(...durationRows(context, symbol, now));
    const counter = references.filter(peer => direction(peer) && direction(peer) !== side).flatMap(peer => passages(context, peer, symbol, sentenceMemo)).find(passage => thesis(passage.text));
    if (counter) { rows.push(row('Counterpoint', counter.text)); sources.push({ label: 'Counterpoint source', citation: counter.citation }); }
    else if (contrary.length) rows.push(row('Counterpoint', `${contrary.join('; ')} → no aligned setup.`));
    rows.push(row('Watch', watchText));
    if (verified && !state.quantity) rows.push({ ...row('Portfolio fit', 'Not held → check overlap before adding.'), requiresFreshHoldings: true });
    output.push(finding({ key: [symbol, 'research-idea', side, reference.productId], material: [side, text(selected.text), contrary, counter?.text || null], symbol, kind: 'opportunity', action: `${side.toLowerCase()} research idea`,
      publishedAt: reference.publishedAt || reference.marketDate, rows, sourceLinks: sources, state: { ...state, researchOnly: true } }));
  }
  return output;
}
function accountFindings(context, now) {
  const account = context.account || {};
  const fresh = account.verified === true && !invalid(account) && dated(account.asOf, new Date(now.getTime() + 30000)) && now.getTime() - time(account.asOf) <= 60000;
  const output = [];
  for (const issue of account.issues || []) {
    if (typeof issue !== 'string') continue;
    const history = issue.match(/^Interest discrepancy \((\d{4}-\d{2}-\d{2})\):/);
    if (history ? account.historyVerified !== true || !dated(history[1], now) : !fresh) continue;
    const type = history ? 'Interest reconciliation' : issue.startsWith('Maintenance margin deficit') ? 'Maintenance margin'
      : issue.startsWith('Initial margin deficit') ? 'Initial margin' : issue.startsWith('Cash-floor shortfall') ? 'Cash funding'
        : issue.startsWith('Policy buffer shortfall') ? 'Policy buffer' : null;
    if (!type) continue;
    const publishedAt = history ? history[1] : account.asOf;
    const citation = { id: `cite_${hash(['account', type, history?.[1] || 'current']).slice(0, 28)}`, title: 'Verified Balance Review evidence', product: 'portfolio-balance', publicationDate: String(publishedAt).slice(0, 10), sourceUri: '/api/portfolio/balance', excerpt: issue };
    output.push(finding({ key: ['account', type, history?.[1]], material: [type, history ? issue : type], symbol: type, kind: 'account', priority: 0, action: 'review account issue', publishedAt,
      rows: [row('Action', history ? 'Reconcile interest' : 'Fix funding/margin shortfall'), row('Context', issue)],
      sourceLinks: [{ label: 'Balance evidence', citation }], state: history ? { researchOnly: true } : { requiresFreshBalance: true, balanceVerified: true, balanceVerifiedAt: account.asOf } }));
  }
  return { findings: output, complete: fresh && account.historyVerified === true };
}
const STANCE_PRODUCT_NAMES = { 'signal-strength': 'Signal Strength', 'signal-strength-shorts': 'Signal Strength Shorts', 'etf-pro': 'ETF Pro', 'real-time-alert': 'Real-Time Alert' };
const monthDay = date => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const amount = value => String(Math.round(value * 100) / 100);
// Where the position is, where the calls take it, and the order between them.
// A trim goes no lower than the security's own MIN and keeps its side.
function stanceOrder(context, symbol, state, side, partial, now) {
  const quantity = Math.abs(state.quantity);
  const weight = state.currentHolding?.weightPct ?? null;
  const verb = side === 'LONG' ? 'SELL' : 'BUY';
  const current = { side, quantity, weightPct: weight };
  if (!partial) return { verdict: 'exit', current, target: { side: null, quantity: 0, weightPct: 0 }, order: { verb, quantity, note: `to close ${side.toLowerCase()}` } };
  const held = (context.holdings.ruleHoldings || []).find(candidate => symbolOf(candidate.holding) === symbol);
  const min = held && weight !== null ? number(evaluatePortfolioRule({ ...held, weightPct: weight }, context.holdings.asOf || now.toISOString()).minWeight) : null;
  if (min === null || min >= weight) return { verdict: 'trim', current, target: { side, quantity: null, weightPct: null }, order: { verb, quantity: null, note: `some · stays ${side.toLowerCase()}` } };
  const remaining = Math.round(quantity * min / weight * 100) / 100;
  return { verdict: 'trim', current, target: { side, quantity: remaining, weightPct: min },
    order: { verb, quantity: Math.round((quantity - remaining) * 100) / 100, upTo: true, note: `stays ${side.toLowerCase()}` } };
}
const orderLine = ({ order }) => `${order.verb} ${order.quantity === null ? 'some' : `${amount(order.quantity)} ${order.quantity === 1 ? 'share' : 'shares'}`}`;
// The whole verified book against every product's standing stance. Unlike a
// source event, a stance holds until the product changes it, so the first
// verified read after Gateway connects sees every contradiction at once.
function stanceFindings(context, now, verified) {
  if (!verified) return [];
  const book = context.stanceBook;
  const output = [];
  for (const scanned of scanHoldings(book, context.holdings.positions)) {
    if (!scanned.opposing.length) continue;
    const { symbol, opposing, supporting } = scanned;
    const state = holdingState(context.holdings, symbol, true, now);
    if (!state.quantity) continue;
    const partial = opposing.every(item => item.partial);
    const key = [symbol, 'stance', scanned.side];
    // A Sell/Cover-SOME is acted on once the position shrinks from where it stood when first raised.
    const latest = opposing[0];
    const previous = (context.previousAttention || []).find(item => item.id === `attention:portfolio:${hash(key).slice(0, 28)}`
      && !['resolved', 'superseded'].includes(item.state));
    const baseline = previous?.stanceBaseline?.date === latest.date ? previous.stanceBaseline : { date: latest.date, quantity: state.quantity };
    if (partial && Math.abs(state.quantity) < Math.abs(baseline.quantity)) continue;
    // The three most recent product calls on this security, either way: the standing ones and the book's
    // earlier calls, one row per product, action and day.
    const calls = [...new Map([...opposing, ...supporting, ...(scanned.history || [])].map(stanceCall)
      .map(call => [[call.product, call.action, call.date].join('|'), call])).values()]
      .sort((a, b) => b.date.localeCompare(a.date) || a.product.localeCompare(b.product)).slice(0, 3);
    const plan = stanceOrder(context, symbol, state, scanned.side, partial, now);
    const rows = [...positionRows(state),
      ...calls.map(call => row(call.product, `${call.action} ${monthDay(call.date)} · ${call.bias}`)),
      { ...row('Order', orderLine(plan)), requiresFreshHoldings: true },
      ...durationRows(context, symbol, now)];
    const sourceLinks = opposing.map(item => ({ label: STANCE_PRODUCT_NAMES[item.product], citation: { id: `cite_${hash([item.sourceUri, item.slot, item.date, item.stance]).slice(0, 24)}`,
      title: `${STANCE_PRODUCT_NAMES[item.product]}: ${symbol} ${item.label}`, product: item.product, publicationDate: item.date, sourceUri: item.sourceUri, excerpt: item.headline || `${symbol} ${item.label}`,
      ...emailClip(item.sourceMessageId, symbol) } }));
    const result = finding({ key, material: [scanned.side, opposing.map(item => [item.slot, item.stance, item.date])],
      symbol, kind: 'portfolio', priority: 0, severity: ACTION_REQUIRED, action: plan.verdict,
      publishedAt: opposing.map(item => item.at).sort().at(-1), rows, sourceLinks, state: { ...state, stanceBaseline: baseline } });
    // The security record names every ticker (ETF Pro, alerts, removed listings); a
    // Signal Strength roster name stands in only while the record cannot.
    const name = securityName(context, symbol) || [...opposing, ...supporting].find(item => item.name)?.name;
    result.presentation.stance = { ...(name ? { name } : {}), calls, ...plan };
    output.push(result);
  }
  return output;
}
// Where a held position stands in its published range, one condition → action line each.
const rangeFigure = value => value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Past either end still reads as that end's third, with the true percentage (127%, -20%).
const rangeWhere = (zone, pct) => `${['top', 'above'].includes(zone) ? 'Top' : 'Bottom'} 1/3 RR (${Math.round(pct)}%)`;
const beyondRange = zone => ['above', 'below'].includes(zone);
function rangeAction(side, zone) {
  const withPosition = side === 'Long' ? { top: 'reduce position', above: 'reduce position', bottom: 'add to position' } : { bottom: 'reduce position', below: 'reduce position', top: 'add to position' };
  return withPosition[zone] || `moving against your ${side}`;
}
const lowerFirst = value => value[0].toLowerCase() + value.slice(1);
const rangeSource = line => (line.cadence === 'weekly' ? `${line.source}; ${monthDay(line.asOf)}` : line.source || 'Risk Ranges');
const rangeCitation = line => [{ label: rangeSource(line), citation: { id: `cite_${hash(['risk-range', line.symbol, line.low, line.high, line.asOf]).slice(0, 28)}`,
  title: `${line.source || 'Risk Ranges'}: ${line.symbol} Risk Range`, product: line.sourceId || 'risk-ranges', publicationDate: line.asOf, excerpt: `${line.symbol} ${rangeFigure(line.low)}–${rangeFigure(line.high)}`, ...emailClip(line.messageId, line.symbol) } }];
function riskRangeFindings(context, now, verified) {
  const watch = context.riskRangeWatch;
  if (!verified || !watch) return [];
  const output = [];
  // The row's text stays for the Analyst's context; the card draws the bar from `range`.
  const rangeRow = line => {
    const printed = alphaLines(context.alphaCodeWatch, line.symbol);
    const levelOf = duration => printed.find(item => item.duration === duration)?.level ?? null;
    return { ...row('Risk Range', `${rangeFigure(line.low)}–${rangeFigure(line.high)} · ${rangeSource(line)}`),
      range: { low: line.low, high: line.high, price: line.price, decimals: 2, unit: '',
        ...(printed.length ? { alphaCode: { trade: levelOf('trade'), trend: levelOf('trend'), approximate: printed.some(item => item.approximate), dots: true, product: printed[0].productLabel || '' } } : {}) } };
  };
  // The security's own MIN / MAX, from the same sizing rule the Above MAX cards use.
  const sizeLimits = (symbol, state) => {
    const held = (context.holdings.ruleHoldings || []).find(candidate => symbolOf(candidate.holding) === symbol);
    if (!held) return [];
    const rule = evaluatePortfolioRule({ ...held, weightPct: state.currentHolding?.weightPct ?? null }, context.holdings.asOf);
    return number(rule.minWeight) === null ? [] : [processLimitRow(rule)];
  };
  for (const line of Object.values(watch.lines || {})) {
    const state = holdingState(context.holdings, line.symbol, true, now);
    if (!state.quantity || line.price === null) continue;
    const side = state.quantity > 0 ? 'Long' : 'Short';
    const weight = state.currentHolding ? ` to ${state.currentHolding.weightPct.toFixed(2)}%` : '';
    const add = (line.adds || []).filter(item => item.date === watch.marketDate && (item.to > 0) === (state.quantity > 0)).at(-1);
    const card = (key, material, action, signal, publishedAt, beyond) => output.push(finding({ key, material, symbol: line.symbol, kind: 'market', priority: 1, action, publishedAt,
      rows: [...positionRows(state), ...sizeLimits(line.symbol, state), { ...row('Signal', signal), ...(beyond ? { beyondRange: true } : {}) }, rangeRow(line), ...durationRows(context, line.symbol, now)], sourceLinks: rangeCitation(line), state }));
    if (add) {
      card([line.symbol, 'risk-range-add', add.date], [line.symbol, add.date, add.zone, side], 'added at the wrong end of the range',
        `${side} added${weight} in ${lowerFirst(rangeWhere(add.zone, add.pct))} → should be MIN size.`, add.at, beyondRange(add.zone));
      continue;
    }
    const entry = line.entries?.at(-1);
    if (!entry || entry.to !== line.zone || line.zone === 'middle') continue;
    card([line.symbol, 'risk-range'], [line.symbol, line.zone, side, entry.at], rangeAction(side, line.zone),
      `${rangeWhere(line.zone, line.pct)} → ${rangeAction(side, line.zone)}.`, entry.at, beyondRange(line.zone));
  }
  for (const note of watch.sizeNotes || []) {
    const state = holdingState(context.holdings, note.symbol, true, now);
    if (!state.quantity) continue;
    const side = state.quantity > 0 ? 'Long' : 'Short';
    if (note.side && note.side !== side.toUpperCase()) continue;
    const weight = state.currentHolding ? ` You hold ${state.currentHolding.weightPct.toFixed(2)}%.` : '';
    const instruction = `${{ covered: 'Cover', sold: 'Sell', trimmed: 'Trim', bought: 'Buy', added: 'Add', shorted: 'Short' }[note.verb] || 'Size'} to ${note.size}`;
    output.push(finding({ key: [note.symbol, 'size-note', note.date, note.size], material: [note.symbol, note.date, note.size], symbol: note.symbol, kind: 'market', priority: 1,
      action: instruction.toLowerCase(), publishedAt: `${note.date}T12:00:00Z`,
      rows: [...positionRows(state), row('Signal', `${instruction}.${weight}`), ...durationRows(context, note.symbol, now)],
      sourceLinks: [{ label: 'Real-Time Alert', citation: { id: `cite_${hash(['size-note', note.symbol, note.date, note.size]).slice(0, 28)}`, title: `Real-Time Alert: ${note.symbol} at ${note.size}`,
        product: 'real-time-alert', publicationDate: note.date, excerpt: note.excerpt, ...(note.sourceUri ? { sourceUri: note.sourceUri } : {}), ...emailClip(note.messageId, note.symbol) } }], state }));
  }
  return output;
}
function evaluateResearchAttention(context = {}, now = new Date()) {
  now = now instanceof Date ? now : new Date(now);
  // Reuse exact source text only within this evaluation; citations, security
  // relevance and current evidence gates remain specific to each reading.
  const sentenceMemo = new Map();
  // One fold serves the stance scan and every alert's list-inferred Trade/Trend.
  context = { ...context, stanceBook: foldStanceEvents(context.stanceBook, context.events || [], now).book };
  const verified = freshBook(context.holdings, now);
  const diagnostics = [...(context.diagnostics || [])];
  if (!verified) diagnostics.push({ component: 'holdings', status: 'unavailable' });
  const portfolio = portfolioFindings(context, now, verified);
  const stances = stanceFindings(context, now, verified);
  const actions = [...stances, ...sourceActionFindings(context, now, verified, portfolio, sentenceMemo), ...pendingCheckFindings(context, now, verified)];
  const opportunities = opportunityFindings(context, now, verified, [...portfolio, ...stances], sentenceMemo);
  const accounts = accountFindings(context, now);
  const alphaCodes = [...alphaCodeFindings(context, now, verified), ...alphaCodePrintFindings(context, now, verified),
    ...spxLevelFindings(context), ...vixFindings(context), ...regimeFindings(context), ...riskRangeFindings(context, now, verified)];
  const completeKinds = [];
  if (verified && context.holdings.researchComplete !== false && context.research?.scanComplete === true) completeKinds.push('portfolio');
  if (context.research?.scanComplete === true && Array.isArray(context.documents?.products)) completeKinds.push('opportunity', 'market');
  if (accounts.complete) completeKinds.push('account');
  const unique = new Map([...portfolio, ...actions, ...opportunities, ...alphaCodes, ...accounts.findings].map(item => [item.id, item]));
  return { findings: [...unique.values()], diagnostics, complete: completeKinds.includes('portfolio') && completeKinds.includes('opportunity') && completeKinds.includes('market'), completeKinds };
}
module.exports = { evaluateResearchAttention, freshBook };
