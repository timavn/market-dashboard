const DEFAULT_STALE_SEC = Number(process.env.IBKR_QUOTE_STALE_SEC || 60);

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isValidPositiveNumber(value) {
  if (value == null) return false;
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) && n > 0;
}

/**
 * @param {string|Date|undefined|null} timestamp
 * @param {number} [maxAgeSec]
 */
function isStaleTimestamp(timestamp, maxAgeSec = DEFAULT_STALE_SEC) {
  if (!timestamp) return true;
  const t = timestamp instanceof Date ? timestamp.getTime() : new Date(timestamp).getTime();
  if (!Number.isFinite(t)) return true;
  return Date.now() - t > maxAgeSec * 1000;
}

/**
 * @param {number|null|undefined} bid
 * @param {number|null|undefined} ask
 */
function computeMid(bid, ask) {
  if (!isValidPositiveNumber(bid) || !isValidPositiveNumber(ask)) return null;
  return (Number(bid) + Number(ask)) / 2;
}

/**
 * @param {{ mid?: number|null, last?: number|null, close?: number|null }} fields
 */
function computeMark(fields) {
  if (isValidPositiveNumber(fields.mid)) return Number(fields.mid);
  if (isValidPositiveNumber(fields.last)) return Number(fields.last);
  if (isValidPositiveNumber(fields.close)) return Number(fields.close);
  return null;
}

module.exports = {
  DEFAULT_STALE_SEC,
  isValidPositiveNumber,
  isStaleTimestamp,
  computeMid,
  computeMark,
};
