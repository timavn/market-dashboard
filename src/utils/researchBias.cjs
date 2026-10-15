const CANONICAL_RESEARCH_BIASES = Object.freeze([
  'BULLISH',
  'NEUTRAL',
  'BEARISH',
]);

const RESEARCH_BIAS_ALIASES = Object.freeze({
  BULL: 'BULLISH',
  BULLISH: 'BULLISH',
  LONG: 'BULLISH',
  BUY: 'BULLISH',
  POSITIVE: 'BULLISH',
  ADD: 'BULLISH',
  BEAR: 'BEARISH',
  BEARISH: 'BEARISH',
  SHORT: 'BEARISH',
  SELL: 'BEARISH',
  NEGATIVE: 'BEARISH',
  REMOVE: 'BEARISH',
  FLAT: 'NEUTRAL',
  HOLD: 'NEUTRAL',
  NEUTRAL: 'NEUTRAL',
});

function normalizeResearchBias(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return normalizeResearchBias(
      value.bias
      ?? value.trend
      ?? value.direction
      ?? value.trade
      ?? value.signal
      ?? value.value,
    );
  }
  const raw = String(value ?? '').trim().toUpperCase();
  return RESEARCH_BIAS_ALIASES[raw] || null;
}

function isCanonicalResearchBias(value) {
  return CANONICAL_RESEARCH_BIASES.includes(String(value || '').trim().toUpperCase());
}

module.exports = {
  CANONICAL_RESEARCH_BIASES,
  isCanonicalResearchBias,
  normalizeResearchBias,
};
