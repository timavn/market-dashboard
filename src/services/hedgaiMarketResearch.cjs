const mappings = require('../../data/research/hedgai/market-mappings.json');

// This is dated research, independent of native quote availability. Never use
// historical batting averages as native contract probabilities or score inputs.
function selectHedgaiMarketReading(projection, marketId) {
  const mapping = mappings[marketId];
  if (!mapping || projection?.version !== 1 || projection.product !== 'hedgai-signals') return null;
  const row = projection.book?.rows?.find(item => item.instrumentId === mapping.instrumentId);
  if (!row) return null;
  return {
    ...row,
    baselineDate: projection.baselineDate,
    metricsDate: row.metricsDate || projection.metricsDate,
    asOf: projection.asOf,
    sourceQuality: projection.sourceQuality,
    sources: projection.sources || [],
    mapping,
    contextOnly: true,
    decisionEligible: false,
    executable: false,
  };
}

function withHedgaiMarketReadings(projection) {
  return { ...projection, marketReadings: Object.fromEntries(Object.keys(mappings)
    .map(id => [id, selectHedgaiMarketReading(projection, id)]).filter(([, row]) => row)) };
}

module.exports = { selectHedgaiMarketReading, withHedgaiMarketReadings };
