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

function deriveNoFromYes(yesBid, yesAsk) {
  const yb = toNum(yesBid);
  const ya = toNum(yesAsk);
  if (yb == null && ya == null) return { no_bid: null, no_ask: null };
  return {
    no_bid: ya != null ? 1 - ya : null,
    no_ask: yb != null ? 1 - yb : null,
  };
}

module.exports = {
  toNum,
  fromKalshiCents,
  fromCmeSnapshot,
  fromForecastEx,
  deriveNoFromYes,
};
