function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

const DEFAULT_GDP_LAG_MONTHS = 1;
const US_LIQUIDITY_ACCELERATION_TOLERANCE = 0.0025;
const US_LIQUIDITY_GREEN_STACK_TO_GDP = 1.05;

const GLOBAL_LIQUIDITY_WEIGHTS = deepFreeze({
  m2_growth_1m: 0.10,
  m2_growth_3m: 0.25,
  m2_growth_6m: 0.25,
  growth_gap: 0.25,
  m2_to_gdp_pressure: 0.15,
});

const GLOBAL_LIQUIDITY_SCORE_BREAKPOINTS = deepFreeze({
  growth: [[-0.05, 100], [0, 65], [0.05, 35], [0.10, 10], [0.15, 0]],
  growthGap: [[-0.05, 100], [0, 70], [0.05, 35], [0.10, 0]],
  ratioLevel: [[0.95, 100], [1.00, 75], [1.05, 55], [1.20, 25], [1.50, 0]],
  ratioTrend: [[-0.05, 100], [0, 65], [0.05, 30], [0.10, 0]],
});

const GLOBAL_LIQUIDITY_REGIME_THRESHOLDS = deepFreeze({
  supportiveBelow: 30,
  neutralCautionBelow: 60,
  yellowRiskBelow: 80,
});

const GLOBAL_LIQUIDITY_RATIO_PRESSURE_WEIGHTS = deepFreeze({
  level: 0.50,
  trend3m: 0.25,
  trend6m: 0.25,
});

module.exports = {
  DEFAULT_GDP_LAG_MONTHS,
  GLOBAL_LIQUIDITY_RATIO_PRESSURE_WEIGHTS,
  GLOBAL_LIQUIDITY_REGIME_THRESHOLDS,
  GLOBAL_LIQUIDITY_SCORE_BREAKPOINTS,
  GLOBAL_LIQUIDITY_WEIGHTS,
  US_LIQUIDITY_ACCELERATION_TOLERANCE,
  US_LIQUIDITY_GREEN_STACK_TO_GDP,
};
