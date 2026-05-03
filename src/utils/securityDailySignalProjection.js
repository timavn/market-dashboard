/**
 * Sketch: deterministic merge of Hedgeye snapshot payloads into one row per (symbol, date).
 * Wire into a batch job or tests — not imported by production UI yet.
 *
 * @typedef {Object} RiskRangeDay
 * @property {string} [trend]
 * @property {number} [lrr]
 * @property {number} [hrr]
 *
 * @typedef {Object} SecurityDailySignalSketch
 * @property {string} symbol
 * @property {string} date
 * @property {Record<string, boolean>} sources
 * @property {string|null} riskRangeTrend
 * @property {number|null} lrr
 * @property {number|null} hrr
 * @property {boolean} signalStrengthListed
 * @property {number|null} portfolioSolutionsRank
 * @property {string|null} macroShowSide
 * @property {string|null} theCallSide
 */

/**
 * @param {Object} params
 * @param {string} params.symbol
 * @param {string} params.date
 * @param {Partial<Record<string, unknown>>} params.snapshotsByType keyed by snapshotType (API shape)
 * @returns {SecurityDailySignalSketch}
 */
export function projectSecurityDailySignalSketch({ symbol, date, snapshotsByType = {} }) {
  const upper = String(symbol || '').trim().toUpperCase();
  const sources = {};

  /** @type {SecurityDailySignalSketch} */
  const row = {
    symbol: upper,
    date,
    sources,
    riskRangeTrend: null,
    lrr: null,
    hrr: null,
    signalStrengthListed: false,
    portfolioSolutionsRank: null,
    macroShowSide: null,
    theCallSide: null
  };

  const rr = snapshotsByType['risk-ranges'];
  if (rr && rr.data && rr.data[upper]) {
    sources['risk-ranges'] = true;
    row.riskRangeTrend = rr.data[upper].trend || null;
    row.lrr = rr.data[upper].lrr != null ? Number(rr.data[upper].lrr) : null;
    row.hrr = rr.data[upper].hrr != null ? Number(rr.data[upper].hrr) : null;
  }

  const ss = snapshotsByType['signal-strength'];
  if (ss && ss.data && Array.isArray(ss.data.stocks)) {
    sources['signal-strength'] = true;
    row.signalStrengthListed = ss.data.stocks.includes(upper);
  }

  const ps = snapshotsByType['portfolio-solutions'];
  if (ps && ps.data && Array.isArray(ps.data.rankings)) {
    const idx = ps.data.rankings.findIndex((r) => String(r.symbol || r.ticker || '').toUpperCase() === upper);
    if (idx >= 0) {
      sources['portfolio-solutions'] = true;
      row.portfolioSolutionsRank = idx + 1;
    }
  }

  const macro = snapshotsByType['the-macro-show'];
  if (macro && macro.data) {
    const side = pickMacroSide(macro.data, upper);
    if (side) {
      sources['the-macro-show'] = true;
      row.macroShowSide = side;
    }
  }

  const call = snapshotsByType['the-call'];
  if (call && call.data) {
    const side = pickMacroSide(call.data, upper);
    if (side) {
      sources['the-call'] = true;
      row.theCallSide = side;
    }
  }

  const momo = snapshotsByType['momo-tracker'];
  if (momo && momo.data && momo.data.stocks && typeof momo.data.stocks === 'object') {
    const slot = momo.data.stocks[upper];
    if (slot && slot.trend) {
      sources['momo-tracker'] = true;
    }
  }

  return row;
}

/** Best-effort: Macro Show / Call shapes vary — extend when parsers stabilize */
function pickMacroSide(data, symbol) {
  const longs = data.longs || data.long || [];
  const shorts = data.shorts || data.short || [];
  const inLong = arrayHasTicker(longs, symbol);
  const inShort = arrayHasTicker(shorts, symbol);
  if (inLong && !inShort) return 'LONG';
  if (inShort && !inLong) return 'SHORT';
  return null;
}

function arrayHasTicker(arr, symbol) {
  if (!Array.isArray(arr)) return false;
  return arr.some((entry) => {
    if (typeof entry === 'string') return entry.toUpperCase() === symbol;
    const t = entry && (entry.ticker || entry.symbol);
    return String(t || '').toUpperCase() === symbol;
  });
}
