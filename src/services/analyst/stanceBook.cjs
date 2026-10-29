// One standing stance per ticker per product list, folded from the research
// ledger. Every product reads the same models, so the whole live book is
// compared against the latest dated stance of each list, not against the day
// an update happened to be published.
// Version 2 reads SOME from alert bodies; an older book is rebuilt from the ledger.
const STANCE_BOOK_VERSION = 2;
const STANCE_PRODUCTS = new Set(['signal-strength', 'etf-pro', 'real-time-alert']);
const SLOT_LABELS = {
  'signal-strength:long': 'Signal Strength', 'signal-strength:short': 'Signal Strength Shorts',
  'etf-pro:long': 'ETF Pro', 'etf-pro:short': 'ETF Pro Shorts', 'real-time-alert': 'Real-Time Alert',
};
// A removal stays a standing instruction for a quarter; an alert is a Trade-duration
// call; a Sell/Cover-SOME is a one-time trim, done or stale within a week.
const EXIT_RETENTION_DAYS = 90;
const ALERT_RETENTION_DAYS = 30;
const PARTIAL_RETENTION_DAYS = 7;
const DAY_MS = 86400000;
// The stance a held side reads from each entry: what it supports, what it opposes, and whether partially.
const EFFECTS = {
  LONG: { supports: 'LONG', opposes: 'SHORT' }, SHORT: { supports: 'SHORT', opposes: 'LONG' },
  EXIT_LONG: { opposes: 'LONG' }, EXIT_SHORT: { opposes: 'SHORT' },
  REDUCE_LONG: { opposes: 'LONG', partial: true }, REDUCE_SHORT: { opposes: 'SHORT', partial: true },
};
const ALERT_STANCES = { BUY: 'LONG', 'BUY-SOME': 'LONG', SHORT: 'SHORT', SELL: 'EXIT_LONG', 'SELL-SOME': 'REDUCE_LONG', COVER: 'EXIT_SHORT', 'COVER-SOME': 'REDUCE_SHORT' };
const ALERT_LABELS = { BUY: 'Buy', 'BUY-SOME': 'Buy-SOME', SHORT: 'Short', SELL: 'Sell', 'SELL-SOME': 'Sell-SOME', COVER: 'Cover', 'COVER-SOME': 'Cover-SOME' };

const TICKER = /^[A-Z][A-Z0-9.-]{0,9}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const symbolOf = value => ({ 'BRK-B': 'BRK.B', 'BRK B': 'BRK.B', 'BF-B': 'BF.B' }[String(value).toUpperCase()] || String(value || '').toUpperCase());
const text = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const days = (from, to) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS;
const untrusted = event => ['mock', 'isMock', 'seed', 'seeded', 'fixture', 'synthetic', 'inferred', 'fallback', 'stale', 'cacheOnly'].some(flag => event[flag] === true);

function emptyStanceBook() {
  return { version: STANCE_BOOK_VERSION, updatedAt: null, backfill: null, rosters: {}, partialAlerts: {}, tickers: {} };
}
function parsedExcerpt(event, symbol) {
  try {
    const parsed = JSON.parse(event.excerpt);
    return parsed && !Array.isArray(parsed) && symbolOf(parsed.ticker || parsed.symbol) === symbol ? parsed : null;
  } catch { return null; }
}
// "Real-Time Alert: Sell-SOME Signal (context): Name (MPC) -KM" or
// "BUY SIGNAL - COVERING SHORT LCID": the subject must be this exact ticker.
function headlineAction(value, symbol) {
  const headline = text(value).replace(/^\*+|\*+$/g, '');
  const titled = headline.match(/^Real-Time Alert:\s*(.+?)\s+Signal\b.*:\s*(?:[^:]*\(([A-Z][A-Z0-9.-]*)\)|([A-Z][A-Z0-9.-]*))\s*-\s*[A-Z]{1,4}$/);
  if (titled) return symbolOf(titled[2] || titled[3]) === symbol ? titled[1] : null;
  const signal = headline.match(/^((?:BUY|SELL|SHORT|COVER)\s+SIGNAL(?:\s*-\s*.+?)?)\s+([A-Z][A-Z0-9.-]*)$/i);
  return signal && symbolOf(signal[2]) === symbol ? signal[1] : null;
}
function alertAction(value) {
  const phrase = text(value).toUpperCase();
  if (!phrase) return null;
  if (/\bCOVER(?:ING)?[\s-]+SOME\b/.test(phrase)) return 'COVER-SOME';
  if (/\bSELL(?:ING)?[\s-]+SOME\b/.test(phrase)) return 'SELL-SOME';
  if (/\bBUY(?:ING)?[\s-]+SOME\b/.test(phrase)) return 'BUY-SOME';
  if (/\bCOVER(?:ING)?\b|\bBUY[\s-]+TO[\s-]+COVER\b/.test(phrase)) return 'COVER';
  if (/\bSHORT(?:ING)?\b/.test(phrase)) return 'SHORT';
  if (/\bSELL(?:ING)?\b|\bEXIT\b/.test(phrase)) return 'SELL';
  if (/\bBUY(?:ING)?\b/.test(phrase)) return 'BUY';
  return null;
}
// "Cover-SOME", "selling SOME", "We'll book-SOME": an alert that books only part
// of a position. The web headline often drops it ("BUY SIGNAL - COVERING SHORT");
// the email subject and body keep it.
const SOME = /\b(?:book(?:ing)?|cover(?:ing)?|sell(?:ing)?|trim(?:ming)?)[\s-]+SOME\b/i;
const PARTIAL = { SELL: 'SELL-SOME', COVER: 'COVER-SOME' };
function reportPartial(event, action) {
  const report = event.sourceReport;
  if (!PARTIAL[action] || !report || report.sourceMessageId !== event.sourceMessageId) return action;
  return SOME.test(text(report.title)) || SOME.test(text(report.bodyText)) ? PARTIAL[action] : action;
}
// Any row of an alert message that says SOME marks the alert partial, whichever
// token the row was indexed under, unless the SOME names another ticker
// ("cover-SOME EWA" inside an EWL alert). Returns the tickers it names; null
// for an untargeted SOME.
const SOME_TARGET = new RegExp(`${SOME.source}(?:\\s+\\$?([A-Z]{2,5})\\b)?`, 'gi');
function partialAlertTargets(event) {
  if (event?.productKey !== 'real-time-alert' || !event.sourceMessageId || !['validated', 'indexed'].includes(event.qualityStatus) || untrusted(event)) return [];
  // Only an uppercase word is a ticker: "sell-SOME into strength" names none.
  return [...text(event.excerpt).matchAll(SOME_TARGET)].map(match => match[1] && /^[A-Z]{2,5}$/.test(match[1]) && !['ON', 'OF', 'IN', 'AT', 'THE', 'AND', 'NOW'].includes(match[1]) ? match[1] : null);
}
const partialFor = (marks, symbol) => Boolean(marks?.targets?.some(target => target === null || target === symbol));
function asPartial(entry) {
  const action = PARTIAL[entry.action];
  return action ? { ...entry, action, label: ALERT_LABELS[action], stance: ALERT_STANCES[action] } : entry;
}
function typedSide(event, source) {
  const side = String(event.positionSide || source?.side || source?.positionSide || '').trim().toUpperCase();
  return ['LONG', 'SHORT'].includes(side) ? side : null;
}

// Each accepted event becomes one or more { symbol, slot, entry }. Anything
// that does not name its own ticker with an explicit action is not a stance.
function stancesFromEvent(event, now) {
  if (!event || !STANCE_PRODUCTS.has(event.productKey) || untrusted(event)
    || !['validated', 'indexed'].includes(event.qualityStatus)
    || !['security', 'ticker', 'equity', 'etf'].includes(String(event.entityType).toLowerCase())) return [];
  const symbol = symbolOf(event.entityId);
  const date = String(event.marketDate || event.publishedAt || '').slice(0, 10);
  const at = Number.isFinite(Date.parse(event.publishedAt)) ? new Date(event.publishedAt).toISOString() : `${date}T00:00:00.000Z`;
  if (!TICKER.test(symbol) || !DATE.test(date) || Date.parse(at) > now.getTime()) return [];
  const base = { date, at, since: date, product: event.productKey, sourceUri: event.sourceUrl || (event.sourceMessageId ? `gmail://message/${event.sourceMessageId}` : null), sourceMessageId: event.sourceMessageId || null };
  if (!base.sourceUri) return [];
  const source = parsedExcerpt(event, symbol);
  const bare = text(event.excerpt).toUpperCase() === symbol || !event.fieldPath;
  const out = (slot, stance, label, extra = {}) => ({ symbol, slot, entry: { ...base, stance, label, ...extra } });

  if (event.productKey === 'signal-strength') {
    const type = event.eventType;
    if (['signal_strength_membership', 'signal_strength_short_membership'].includes(type)) {
      if (!source) return [];
      const short = type === 'signal_strength_short_membership';
      const since = DATE.test(String(source.entryDate)) && source.entryDate <= date ? source.entryDate : date;
      const name = typeof source.name === 'string' && source.name.trim() ? { name: source.name.trim().slice(0, 80) } : {};
      return [out(short ? 'signal-strength:short' : 'signal-strength:long', short ? 'SHORT' : 'LONG', 'Listed', { since, roster: true, ...name })];
    }
    if (!bare) return [];
    if (type === 'signal_strength_added') return [out('signal-strength:long', 'LONG', 'Added')];
    // The main list is bullish signals only; its removal exits a Long.
    if (type === 'signal_strength_removed') return [out('signal-strength:long', 'EXIT_LONG', 'Removed')];
    if (type === 'signal_strength_short_added') return [out('signal-strength:short', 'SHORT', 'Added')];
    if (type === 'signal_strength_short_removed') return [out('signal-strength:short', 'EXIT_SHORT', 'Removed')];
    return [];
  }

  if (event.productKey === 'etf-pro') {
    // Ledger rows carry "ADD LONG" at data.changes[n]; typed mail events carry action + side.
    const change = /^data\.changes\[\d+\]$/.test(event.fieldPath || '') ? text(event.excerpt).toUpperCase().match(/^(ADD|REMOVE)\s+(LONG|SHORT)$/) : null;
    const action = change ? change[1] : String(event.action || source?.action || '').trim().toUpperCase();
    const side = change ? change[2] : typedSide(event, source);
    if (!change && !(bare || source)) return [];
    if (action === 'ADD' && side) return [out(`etf-pro:${side.toLowerCase()}`, side, `Added ${side === 'LONG' ? 'Long' : 'Short'}`)];
    if (['REMOVE', 'ROSTER-REMOVAL'].includes(action)) {
      // A removal without a stated side still applies to whichever side is held.
      return (side ? [side] : ['LONG', 'SHORT']).map(held => out(`etf-pro:${held.toLowerCase()}`, `EXIT_${held}`, `Removed ${held === 'LONG' ? 'Long' : 'Short'}`));
    }
    return [];
  }

  // Real-Time Alerts: the headline is the most specific statement of the action.
  const headline = headlineAction(source?.headline, symbol) || headlineAction(event.excerpt, symbol);
  let action = alertAction(headline) || alertAction(source?.signalPhrase) || alertAction(source?.action)
    || (bare || source ? alertAction(event.action || event.actionType) : null);
  if (!action) return [];
  action = reportPartial(event, action);
  const said = source?.headline || (headline ? text(event.excerpt).replace(/^\*+|\*+$/g, '') : '');
  return [out('real-time-alert', ALERT_STANCES[action], ALERT_LABELS[action], { action, ...(said ? { headline: said.slice(0, 240) } : {}) })];
}

// Newer market date wins; on the same date a removal or exit outranks a listing,
// since a missed exit costs more than a removal reviewed and kept. One alert
// restated at the same instant ("SELL SIGNAL MPC") keeps its explicit SOME.
const RANK = { LONG: 0, SHORT: 0, REDUCE_LONG: 1, REDUCE_SHORT: 1, EXIT_LONG: 2, EXIT_SHORT: 2 };
function newer(slot, entry, current) {
  if (!current) return true;
  if (entry.date !== current.date) return entry.date > current.date;
  if (entry.at !== current.at) return entry.at > current.at;
  if (slot === 'real-time-alert') return /SOME/.test(entry.action) && !/SOME/.test(current.action);
  return RANK[entry.stance] > RANK[current.stance];
}
function prune(book, today) {
  for (const [symbol, slots] of Object.entries(book.tickers)) {
    for (const [slot, entry] of Object.entries(slots)) {
      const age = days(entry.date, today);
      const expired = slot === 'real-time-alert' ? age > (EFFECTS[entry.stance].partial ? PARTIAL_RETENTION_DAYS : ALERT_RETENTION_DAYS)
        : entry.stance.startsWith('EXIT_') ? age > EXIT_RETENTION_DAYS
          : entry.roster && book.rosters[slot] && days(entry.seen || entry.date, book.rosters[slot]) > ALERT_RETENTION_DAYS;
      if (expired) delete slots[slot];
    }
    if (!Object.keys(slots).length) delete book.tickers[symbol];
  }
}
// Folding is idempotent: the same events can be replayed every scan.
function foldStanceEvents(stored, events = [], now = new Date()) {
  const book = stored?.version === STANCE_BOOK_VERSION ? JSON.parse(JSON.stringify(stored)) : emptyStanceBook();
  const before = JSON.stringify([book.rosters, book.partialAlerts, book.tickers]);
  for (const event of events) {
    const targets = partialAlertTargets(event);
    if (!targets.length) continue;
    const marks = book.partialAlerts[event.sourceMessageId] || (book.partialAlerts[event.sourceMessageId] = { date: String(event.marketDate || event.publishedAt || '').slice(0, 10), targets: [] });
    for (const target of targets) if (!marks.targets.includes(target)) marks.targets.push(target);
  }
  for (const event of events) {
    for (const { symbol, slot, entry } of stancesFromEvent(event, now)) {
      const slots = book.tickers[symbol] || (book.tickers[symbol] = {});
      const current = slots[slot];
      const dropped = current?.roster && book.rosters[slot] && (current.seen || current.date) < book.rosters[slot];
      if (entry.roster && !(book.rosters[slot] >= entry.date)) book.rosters[slot] = entry.date;
      // A repeated listing keeps its entry date and cites the latest edition that
      // still lists it. A reaffirmed listing is not a new call (see scanHoldings).
      if (current && !dropped && current.stance === entry.stance && ['LONG', 'SHORT'].includes(entry.stance) && entry.date >= current.date) {
        if (entry.roster) {
          if (entry.date > current.date) Object.assign(current, { date: entry.date, at: entry.at, sourceUri: entry.sourceUri, sourceMessageId: entry.sourceMessageId, label: 'Listed' });
          if (entry.name && !current.name) current.name = entry.name;
          Object.assign(current, { roster: true, seen: current.date, since: entry.since < current.since ? entry.since : current.since });
        }
        // The edition that adds a name also lists it; "Added" says more.
        if (entry.label === 'Added' && entry.date === current.date) Object.assign(current, { label: 'Added', since: entry.since > current.since ? current.since : entry.since });
        continue;
      }
      if (newer(slot, entry, current)) slots[slot] = entry.roster ? { ...entry, seen: entry.date } : entry;
    }
  }
  // A body row can arrive after its headline, even in a later fold.
  for (const [symbol, slots] of Object.entries(book.tickers)) {
    const alert = slots['real-time-alert'];
    if (alert && partialFor(book.partialAlerts[alert.sourceMessageId], symbol)) slots['real-time-alert'] = asPartial(alert);
  }
  const today = now.toISOString().slice(0, 10);
  for (const [message, marks] of Object.entries(book.partialAlerts)) if (days(marks.date, today) > ALERT_RETENTION_DAYS) delete book.partialAlerts[message];
  prune(book, today);
  const changed = JSON.stringify([book.rosters, book.partialAlerts, book.tickers]) !== before;
  if (changed) book.updatedAt = now.toISOString();
  return { book, changed };
}

// Compare every held position to its ticker's standing stances. An opposing
// stance stands unless some product supports the held side from a later date.
function scanHoldings(book, positions = []) {
  const held = new Map();
  for (const position of positions) {
    if (position.category === 'event_contract' || typeof position.quantity !== 'number') continue;
    const symbol = symbolOf(position.symbol);
    held.set(symbol, (held.get(symbol) || 0) + position.quantity);
  }
  const rows = [];
  for (const [symbol, quantity] of held) {
    if (!quantity) continue;
    const side = quantity > 0 ? 'LONG' : 'SHORT';
    const supporting = [];
    const opposing = [];
    for (const [slot, entry] of Object.entries(book?.tickers?.[symbol] || {})) {
      // A listing that dropped off its latest roster without a removal is unknown, not a stance.
      if (entry.roster && book.rosters?.[slot] && (entry.seen || entry.date) < book.rosters[slot]) continue;
      const effect = EFFECTS[entry.stance];
      const item = { ...entry, slot, productLabel: SLOT_LABELS[slot], partial: Boolean(effect?.partial) };
      if (effect?.supports === side) supporting.push(item);
      else if (effect?.opposes === side) opposing.push(item);
    }
    // Support counts from when it was established, so an unchanged listing never
    // outranks a newer change; an opposing listing stands while it is still listed.
    const latestSupport = supporting.map(item => item.since).sort().at(-1) || '';
    const standing = opposing.filter(item => !(latestSupport > item.date)).sort((a, b) => b.date.localeCompare(a.date) || a.slot.localeCompare(b.slot));
    rows.push({ symbol, side, quantity, opposing: standing, supporting });
  }
  return rows;
}

// History for a new book: the stance products' ledger rows for the last
// `days` calendar dates (products also publish on weekends), a few dates at a time.
const LEDGER_FIELDS = ['entityId', 'entityType', 'eventType', 'productKey', 'productLabel', 'fieldPath', 'excerpt', 'marketDate',
  'publishedAt', 'sourceUrl', 'sourceMessageId', 'qualityStatus', 'matchType', 'direction', 'eventKey'];
async function loadStanceLedger(dynamodb, { days = EXIT_RETENTION_DAYS, now = new Date(), tableName = 'ResearchEntityEventsV1', indexName = 'marketDate-index', concurrency = 6 } = {}) {
  const dates = Array.from({ length: days }, (_, index) => new Date(now.getTime() - index * DAY_MS).toISOString().slice(0, 10));
  const products = [...STANCE_PRODUCTS];
  const names = Object.fromEntries(LEDGER_FIELDS.map((field, index) => [`#f${index}`, field]));
  const name = field => `#f${LEDGER_FIELDS.indexOf(field)}`;
  const query = async marketDate => {
    const items = [];
    let ExclusiveStartKey;
    do {
      const page = await dynamodb.query({ TableName: tableName, IndexName: indexName, KeyConditionExpression: `${name('marketDate')} = :date`,
        FilterExpression: `${name('productKey')} IN (${products.map((_, index) => `:p${index}`).join(', ')})`, ProjectionExpression: Object.keys(names).join(', '),
        ExpressionAttributeNames: names, ExpressionAttributeValues: { ':date': marketDate, ...Object.fromEntries(products.map((product, index) => [`:p${index}`, product])) },
        ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}) }).promise();
      items.push(...(page.Items || []));
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  };
  const events = [];
  for (let offset = 0; offset < dates.length; offset += concurrency) {
    for (const items of await Promise.all(dates.slice(offset, offset + concurrency).map(query))) events.push(...items);
  }
  return { from: dates.at(-1), through: dates[0], events };
}

module.exports = { STANCE_BOOK_VERSION, STANCE_PRODUCTS, SLOT_LABELS, emptyStanceBook, stancesFromEvent, foldStanceEvents, scanHoldings, loadStanceLedger };
