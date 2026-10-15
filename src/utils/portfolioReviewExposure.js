// Read-only percentages from this review's captured accounting evidence.
// Never reconstruct its denominator from rounded ratios or current holdings.
export function portfolioExposurePercentages(metrics = {}) {
  const nlv = metrics.netLiquidation;
  const hasNlv = Number.isFinite(nlv) && nlv > 0;
  return {
    gross: Number.isFinite(metrics.grossLeverage) ? metrics.grossLeverage * 100 : null,
    long: hasNlv && Number.isFinite(metrics.longMarketValue) ? metrics.longMarketValue / nlv * 100 : null,
    short: hasNlv && Number.isFinite(metrics.shortMarketValue) ? metrics.shortMarketValue / nlv * 100 : null,
    net: Number.isFinite(metrics.netExposurePctOfNlv) ? metrics.netExposurePctOfNlv : null,
  };
}
