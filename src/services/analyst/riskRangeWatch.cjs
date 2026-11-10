// Each held security's place in its published Risk Range, watched through the
// session. Thirds match the Predictive Markets bar: 33% and below is the bottom,
// 66% and above the top. Sizing into the wrong end is the costly mistake: a short
// added at the low end, or a long added at the high end.
const WATCH_VERSION = 1;
// A zone change counts once the price clears the boundary by 2% of the range's width,
// so a price sitting on a line does not flip it back and forth.
const HYSTERESIS = 0.02;
const KEPT_ENTRIES = 6;
const RANK = { below: 0, bottom: 1, middle: 2, top: 3, above: 4 };
// Sizing up on a short near the low, or a long near the high.
const WRONG_ZONES = { short: ['bottom', 'below'], long: ['top', 'above'] };
const finite = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function rangeZone(price, low, high) {
  const pct = ((price - low) / (high - low)) * 100;
  const rounded = Math.round(pct);
  return { pct, zone: price < low ? 'below' : price > high ? 'above' : rounded <= 33 ? 'bottom' : rounded >= 66 ? 'top' : 'middle' };
}

// The zone to read: a new one only when the price is clear of the band around the line it crossed.
function settledZone(price, low, high, current) {
  const { zone } = rangeZone(price, low, high);
  if (!current || zone === current) return zone;
  const backToward = RANK[zone] > RANK[current] ? -1 : 1;
  return rangeZone(price + backToward * HYSTERESIS * (high - low), low, high).zone === current ? current : zone;
}

const grew = (before, after) => Boolean(after) && (before === 0 || Math.sign(before) !== Math.sign(after) || Math.abs(after) > Math.abs(before));

// A single scan can misread the book (positions at exactly double, once, on 2026-11-09),
// so a new quantity counts only when two scans in a row agree on it.
function settledQuantities(reading, lastReading, confirmed) {
  const settled = {};
  for (const symbol of new Set([...Object.keys(reading), ...Object.keys(lastReading), ...Object.keys(confirmed)])) {
    const now = reading[symbol] || 0;
    const value = now === (lastReading[symbol] || 0) ? now : confirmed[symbol] || 0;
    if (value) settled[symbol] = value;
  }
  return settled;
}

// An add stands while the book still shows that size; trimmed back, or never really there, it goes.
const stillHeld = (add, held) => held === null || (Math.sign(held) === Math.sign(add.to) && Math.abs(held) + 1e-6 >= Math.abs(add.to));

/**
 * Fold the held securities' ranges and prices into the stored watch.
 * ranges: [{ symbol, low, high, source, sourceId, asOf, cadence }]; prices: { [symbol]: { price, asOf } };
 * positions: { [symbol]: signedQuantity } from a verified book, or null when none was verified.
 * The first reading of a security sets its starting zone and raises nothing.
 */
function foldRiskRangeWatch(stored, { marketDate = null, ranges = [], prices = {}, positions = null, sizeNotes = [], complete = true, now = new Date() } = {}) {
  const at = now.toISOString();
  const previous = stored?.version === WATCH_VERSION ? stored : null;
  const before = previous?.quantities || null;
  const lastReading = previous?.reading || before;
  const settled = positions && before ? settledQuantities(positions, lastReading, before) : positions;
  const lines = {};
  // A partial read keeps the lines it did not reach, so a brief gap cannot restart their zones.
  if (previous && !complete) Object.assign(lines, previous.lines);
  for (const range of ranges) {
    const kept = previous?.lines?.[range.symbol] || null;
    const line = { ...range, price: kept?.price ?? null, priceAt: kept?.priceAt ?? null, pct: kept?.pct ?? null, zone: kept?.zone ?? null,
      since: kept?.since ?? null, entries: kept?.entries || [], adds: (kept?.adds || []).filter(add => add.date === marketDate && stillHeld(add, settled ? settled[range.symbol] || 0 : null)) };
    const quote = prices[range.symbol];
    const price = finite(quote?.price);
    if (price !== null) {
      line.price = price;
      line.priceAt = quote.asOf || at;
      line.pct = rangeZone(price, line.low, line.high).pct;
      const zone = settledZone(price, line.low, line.high, line.zone);
      if (zone !== line.zone) {
        if (line.zone) line.entries = [...line.entries, { from: line.zone, to: zone, price, pct: line.pct, at: line.priceAt }].slice(-KEPT_ENTRIES);
        line.zone = zone;
        line.since = line.priceAt;
      }
      if (settled && before) {
        const held = settled[range.symbol] || 0;
        const was = before[range.symbol] || 0;
        if (grew(was, held) && WRONG_ZONES[held > 0 ? 'long' : 'short'].includes(line.zone)) {
          line.adds = [...line.adds, { date: marketDate, from: was, to: held, price, pct: line.pct, zone: line.zone, at: line.priceAt }];
        }
      }
    }
    lines[range.symbol] = line;
  }
  const quantities = settled || before;
  const reading = positions || lastReading;
  const watch = { version: WATCH_VERSION, marketDate, updatedAt: at, lines, sizeNotes, ...(quantities ? { quantities, reading } : {}) };
  // Prices move every scan; the stored copy changes only when something it decides does.
  const material = value => JSON.stringify([Object.values(value?.lines || {}).map(line => [line.symbol, line.low, line.high, line.asOf, line.zone, line.entries, line.adds]), value?.quantities || null, value?.reading || null, value?.sizeNotes || []]);
  return { watch, changed: !previous || previous.marketDate !== marketDate || material(previous) !== material(watch) };
}

// "Covered my DRAM down to its MIN position SIZE": Keith stating his own size for one
// named ticker. The ticker must be printed in capitals, and a conditional, future or
// negated lead-in voids it: a wrong note is worse than a missed one.
const SIZE_NOTE = /\b(covered|sold|trimmed|bought|added|shorted)\s+(?:my\s+|our\s+|the\s+)?\$?([A-Za-z][A-Za-z0-9.]{0,5})\s+(?:position\s+)?(?:(?:back\s+)?(?:down|up)\s+|back\s+)?to\s+(?:its\s+|a\s+|the\s+|my\s+|our\s+)?(MIN|MAX|minimum|maximum)\b(?:\s+(?:position\s+)?size|\s+position)?/gi;
const HYPOTHETICAL = /\b(?:if|would|could|might|may|will|should|shall|plan(?:ning)?\s+to|going\s+to|never|not|didn'?t|haven'?t)\b[^.!?]*$/i;
const NOTE_SIDE = { covered: 'SHORT', shorted: 'SHORT', sold: 'LONG', bought: 'LONG' };
const NOTE_RETENTION_DAYS = 7;

function sizeNotesFromEvents(events = [], { now = new Date() } = {}) {
  const notes = new Map();
  for (const event of events) {
    if (event?.productKey !== 'real-time-alert' || !['validated', 'indexed'].includes(event.qualityStatus)) continue;
    const date = String(event.marketDate || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || (now.getTime() - Date.parse(`${date}T00:00:00Z`)) / 86_400_000 > NOTE_RETENTION_DAYS) continue;
    const excerpt = String(event.excerpt || '').replace(/\s+/g, ' ');
    for (const match of excerpt.matchAll(SIZE_NOTE)) {
      const [phrase, verb, ticker, size] = match;
      // Only the row indexed under the ticker it names: one sentence is many ledger rows.
      if (ticker !== ticker.toUpperCase() || ticker !== String(event.entityId || '').toUpperCase()) continue;
      if (HYPOTHETICAL.test(excerpt.slice(Math.max(0, match.index - 60), match.index))) continue;
      const label = /^min/i.test(size) ? 'MIN' : 'MAX';
      notes.set(`${ticker}|${date}|${label}`, { symbol: ticker, date, size: label, verb: verb.toLowerCase(), side: NOTE_SIDE[verb.toLowerCase()] || null, excerpt: phrase,
        messageId: event.sourceMessageId || null, sourceUri: event.sourceUrl || (event.sourceMessageId ? `gmail://message/${event.sourceMessageId}` : null) });
    }
  }
  return [...notes.values()].sort((left, right) => right.date.localeCompare(left.date) || left.symbol.localeCompare(right.symbol));
}

/**
 * Closes with the range in force each session: the daily sheet's range for its own date,
 * otherwise the latest weekly edition printed on or before the session.
 */
function rangeHistory({ bars = [], daily = [], weekly = [], sessions = 60 } = {}) {
  const valid = item => item && /^\d{4}-\d{2}-\d{2}$/.test(item.date) && item.low > 0 && item.high > item.low;
  const dailyByDate = new Map(daily.filter(valid).map(item => [item.date, item]));
  const editions = weekly.filter(valid).sort((left, right) => left.date.localeCompare(right.date));
  const rows = bars.filter(bar => /^\d{4}-\d{2}-\d{2}$/.test(bar.date) && bar.close > 0).sort((left, right) => left.date.localeCompare(right.date)).map(bar => {
    const own = dailyByDate.get(bar.date);
    const edition = own ? null : editions.filter(item => item.date <= bar.date).at(-1);
    const range = own || edition;
    return { date: bar.date, close: bar.close, low: range?.low ?? null, high: range?.high ?? null, cadence: own ? 'daily' : edition ? 'weekly' : null };
  });
  return rows.slice(-sessions);
}

module.exports = { HYSTERESIS, WRONG_ZONES, foldRiskRangeWatch, rangeHistory, rangeZone, sizeNotesFromEvents };
