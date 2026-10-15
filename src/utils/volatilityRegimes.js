export const VOL_RANGES = Object.freeze({
  /*
   * G5 1M FX volatility is an annualized 21-session standard deviation in
   * the Yahoo fallback and uses the same annualized percentage scale as the
   * CME FXVL series. These are intentionally heuristic UI bands: low FX vol
   * below 8, a normal/choppy middle band from 8 to 14, and elevated stress
   * above 14. They are not provider-defined trading signals.
   */
  G5RV: Object.freeze({
    name: 'G5 FX 1M Realized Vol',
    source: 'Heuristic framework for annualized G5 FX realized volatility',
    ranges: Object.freeze([
      Object.freeze({ min: 0, max: 8, label: 'Investable', color: 'green', desc: 'Low realized FX vol' }),
      Object.freeze({ min: 8, max: 14, label: 'Chop', color: 'yellow', desc: 'Normal-to-elevated FX vol' }),
      Object.freeze({ min: 14, max: null, label: 'Uninvestable', color: 'red', desc: 'Elevated realized FX vol' }),
    ]),
  }),
  FXVL: Object.freeze({
    name: 'G5 FX 1M Volatility',
    source: 'Heuristic framework aligned to the G5 FX annualized-vol scale',
    ranges: Object.freeze([
      Object.freeze({ min: 0, max: 8, label: 'Investable', color: 'green', desc: 'Low G5 FX vol' }),
      Object.freeze({ min: 8, max: 14, label: 'Chop', color: 'yellow', desc: 'Normal-to-elevated G5 FX vol' }),
      Object.freeze({ min: 14, max: null, label: 'Uninvestable', color: 'red', desc: 'Elevated G5 FX vol' }),
    ]),
  }),
  VIX: Object.freeze({
    name: 'VIX (S&P 500 Implied Vol)',
    source: 'The Process',
    ranges: Object.freeze([
      Object.freeze({ min: 0, max: 20, label: 'Investable', color: 'green', desc: 'Buy dips, normal risk' }),
      Object.freeze({ min: 20, max: 29, label: 'Chop', color: 'yellow', desc: 'Trade ranges, be aggressive on longs' }),
      Object.freeze({ min: 29, max: null, label: 'Uninvestable', color: 'red', desc: 'Defensive, preserve capital' }),
    ]),
  }),
  RVX: Object.freeze({
    name: 'RVX (Russell 2000 Implied Vol)',
    source: 'Heuristic framework (not source-defined)',
    ranges: Object.freeze([
      Object.freeze({ min: 0, max: 24, label: 'Investable', color: 'green', desc: 'Typically ~1.2x VIX' }),
      Object.freeze({ min: 24, max: 36, label: 'Chop', color: 'yellow', desc: 'Trade ranges' }),
      Object.freeze({ min: 36, max: null, label: 'Uninvestable', color: 'red', desc: 'Defensive' }),
    ]),
  }),
  NazVol: Object.freeze({
    name: 'NazVol / VXN (Nasdaq Implied Vol)',
    source: 'Heuristic framework (not source-defined)',
    ranges: Object.freeze([
      Object.freeze({ min: 0, max: 24, label: 'Investable', color: 'green', desc: 'Typically ~1.2x VIX' }),
      Object.freeze({ min: 24, max: 36, label: 'Chop', color: 'yellow', desc: 'Trade ranges' }),
      Object.freeze({ min: 36, max: null, label: 'Uninvestable', color: 'red', desc: 'Defensive' }),
    ]),
  }),
  GVZ: Object.freeze({
    name: 'GVZ (Gold Implied Vol)',
    source: 'Heuristic framework based on The Process',
    ranges: Object.freeze([
      Object.freeze({ min: 0, max: 24, label: 'Investable', color: 'green', desc: 'Low vol regime' }),
      Object.freeze({ min: 24, max: 36, label: 'Chop', color: 'yellow', desc: 'Trade ranges' }),
      Object.freeze({ min: 36, max: null, label: 'Uninvestable', color: 'red', desc: 'Defensive' }),
    ]),
  }),
  OVX: Object.freeze({
    name: 'OVX (Oil Implied Vol)',
    source: 'Heuristic framework (not source-defined)',
    ranges: Object.freeze([
      Object.freeze({ min: 0, max: 40, label: 'Investable', color: 'green', desc: 'Lower vol regime' }),
      Object.freeze({ min: 40, max: 55, label: 'Chop', color: 'yellow', desc: 'Trade ranges' }),
      Object.freeze({ min: 55, max: null, label: 'Uninvestable', color: 'red', desc: 'Defensive' }),
    ]),
  }),
  MOVE: Object.freeze({
    name: 'MOVE (Bond Market Implied Vol)',
    source: 'Heuristic framework for the Treasury-volatility scale',
    ranges: Object.freeze([
      Object.freeze({ min: 0, max: 100, label: 'Investable', color: 'green', desc: 'Lower vol regime' }),
      Object.freeze({ min: 100, max: 120, label: 'Chop', color: 'yellow', desc: 'Trade ranges' }),
      Object.freeze({ min: 120, max: null, label: 'Uninvestable', color: 'red', desc: 'Defensive' }),
    ]),
  }),
  VVIX: Object.freeze({
    name: 'VVIX (VIX of VIX – Vol of Vol)',
    source: 'Heuristic framework for Cboe VVIX',
    ranges: Object.freeze([
      Object.freeze({ min: 0, max: 95, label: 'Investable', color: 'green', desc: 'Lower vol-of-vol' }),
      Object.freeze({ min: 95, max: 115, label: 'Chop', color: 'yellow', desc: 'Elevated vol-of-vol' }),
      Object.freeze({ min: 115, max: null, label: 'Uninvestable', color: 'red', desc: 'Defensive' }),
    ]),
  }),
});

export const getBucketForSeries = (seriesName, value) => {
  if (value == null || value === '' || Number.isNaN(Number(value))) return null;
  const ranges = VOL_RANGES[seriesName]?.ranges;
  if (!ranges?.length) return null;
  const numeric = Number(value);
  return ranges.find((range) => numeric >= range.min && (range.max == null || numeric < range.max))?.color || null;
};

export const formatVolatilityRange = (range) => {
  if (!range) return null;
  if (range.max == null) return `>${range.min}`;
  if (Number(range.min) === 0) return `<${range.max}`;
  return `${range.min}–${range.max}`;
};
