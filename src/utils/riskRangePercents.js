/**
 * Hedgeye risk-range % math (matches momo-tracker convention).
 * upside%   = (HRR - price) / price × 100
 * downside% = (LRR - price) / price × 100
 */

function toFinite(n) {
  if (n == null || n === '') return null;
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Pick reference price: live spot when market is open, else prior close.
 * @param {{ spot?: number|null, previousClose?: number|null, source?: string|null }} opts
 */
export function resolveReferencePrice({ spot, previousClose, source } = {}) {
  const spotNum = toFinite(spot);
  const closeNum = toFinite(previousClose);

  const isLive =
    spotNum != null &&
    (source === 'ibkr' ||
      (closeNum != null && Math.abs(spotNum - closeNum) > 0.0001));

  if (isLive) return spotNum;
  if (closeNum != null) return closeNum;
  return spotNum;
}

/**
 * @param {number} referencePrice
 * @param {number} lrr - low risk range (buy level)
 * @param {number} hrr - high risk range (sell level)
 * @returns {{ upsidePct: number, downsidePct: number } | null}
 */
export function computeRiskRangePercents(referencePrice, lrr, hrr) {
  const price = toFinite(referencePrice);
  if (price == null || lrr == null || hrr == null || lrr === '' || hrr === '') {
    return null;
  }
  const low = Number(lrr);
  const high = Number(hrr);
  if (!Number.isFinite(low) || !Number.isFinite(high)) {
    return null;
  }

  return {
    upsidePct: ((high - price) / price) * 100,
    downsidePct: ((low - price) / price) * 100,
  };
}

/**
 * Rank a complete, source-reported range from its reference close without
 * manufacturing a missing endpoint. Upside is the move to HRR, downside is
 * the move to LRR, and largestMovePct captures the more significant side.
 * @returns {{ largestMovePct: number, upsidePct: number, downsidePct: number } | null}
 */
export function computeRiskRangeActionability(referencePrice, lrr, hrr) {
  const rangePercents = computeRiskRangePercents(referencePrice, lrr, hrr);
  if (!rangePercents) return null;
  return {
    largestMovePct: Math.max(
      Math.abs(rangePercents.upsidePct),
      Math.abs(rangePercents.downsidePct),
    ),
    upsidePct: Math.max(0, rangePercents.upsidePct),
    downsidePct: Math.max(0, -rangePercents.downsidePct),
  };
}

export function formatRiskRangePercent(value) {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value.toFixed(1)}%`;
}
