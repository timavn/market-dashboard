/**
 * Plain numeric display with commas; decimals only when needed (unless forced).
 */
export function formatRangeNumber(n, options = {}) {
  if (!Number.isFinite(n)) return '—';
  const { minDecimals = 0, maxDecimals = 2 } = options;
  const hasFraction = Math.abs(n % 1) > 1e-9;
  const md =
    maxDecimals === 2 && hasFraction ? 2 : !hasFraction && minDecimals === 0 ? Math.abs(n) >= 100 ? 0 : maxDecimals : maxDecimals;
  return Number(n).toLocaleString(undefined, {
    minimumFractionDigits: hasFraction ? Math.min(minDecimals, 2) : minDecimals,
    maximumFractionDigits: md,
  });
}

/** Equity index band endpoints — no $; VIX keeps two decimals (19.10 vs float drift). */
export function formatIndexBoundary(n, canonical) {
  if (!Number.isFinite(n)) return '—';
  const sym = canonical?.symbol;
  const forceTwo = sym === 'VIX';
  const fracish = forceTwo || Math.abs(n % 1) > 1e-5;
  if (fracish) {
    return Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
}

/** Live spot / emphasis — keep up to 2 fraction digits when present. */
export function formatIndexSpot(n) {
  if (!Number.isFinite(n)) return '—';
  const hasFraction = Math.abs(n % 1) > 1e-9;
  return Number(n).toLocaleString(undefined, {
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: 2,
  });
}

/**
 * Forecast band endpoints — no $ on equity indices.
 */
export function formatBoundaryForAsset(n, canonical) {
  if (!Number.isFinite(n)) return '—';
  const group = canonical?.group;
  if (group === 'Rates') return `${n.toFixed(2)}%`;
  if (group === 'FX') return n >= 10 ? formatRangeNumber(n) : n.toFixed(4);
  if (group === 'Crypto' || group === 'Commodities') {
    return `$${Number(n).toLocaleString(undefined, {
      maximumFractionDigits: Number(n) >= 100 ? 0 : 2,
    })}`;
  }
  return formatIndexBoundary(n, canonical);
}

/**
 * Spot under range — commas + decimals per asset; indices omit $ unless commodities/crypto etc.
 */
export function formatSpotDisplayForAsset(n, canonical) {
  if (!Number.isFinite(n)) return null;
  const group = canonical?.group;
  if (group === 'Rates') return `${n.toFixed(2)}%`;
  if (group === 'FX') return n >= 10 ? formatIndexSpot(n) : n.toFixed(4);
  if (group === 'Crypto' || group === 'Commodities') {
    return `$${Number(n).toLocaleString(undefined, {
      minimumFractionDigits: Number(n) % 1 !== 0 ? 2 : 0,
      maximumFractionDigits: 2,
    })}`;
  }
  return formatIndexSpot(n);
}
