/**
 * Convert venue-native prices to normalized $0–$1 probability scale.
 */

function toNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Kalshi: cents 0–100 */
function fromKalshiCents(cents) {
  const n = toNum(cents);
  if (n == null) return null;
  return n > 1 ? n / 100 : n;
}

/** CME event contracts via IBKR snapshot: often 0–100 scale */
function fromCmeSnapshot(price) {
  const n = toNum(price);
  if (n == null) return null;
  if (n > 1) return n / 100;
  return n;
}

/** ForecastEx: already 0–1 dollar prices */
function fromForecastEx(price) {
  const n = toNum(price);
  if (n == null) return null;
  if (n > 1) return n / 100;
  return n;
}

module.exports = {
  toNum,
  fromKalshiCents,
  fromCmeSnapshot,
  fromForecastEx,
};
