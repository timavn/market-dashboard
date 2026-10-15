const { normalizeMarket } = require('../predictionMarketTest/morningReport.cjs');
const { setupCapacity } = require('./analystPolicy.cjs');
const MARKETS = [['cpi', 'CPI', 'forecastex'], ['sp500', 'S&P 500', 'forecastex'], ['gold', 'Gold', 'kalshi'], ['silver', 'Silver', 'kalshi'], ['bitcoin', 'Bitcoin', 'kalshi'], ['ethereum', 'Ethereum', 'kalshi']];
const number = v => v !== null && v !== '' && typeof v !== 'boolean' && Number.isFinite(Number(v)) ? Number(v) : null;
function verified(source, now) { const age = now - Date.parse(source?.asOf); return source?.liveVerified === true && ['live', 'live_with_dated_verified_history'].includes(source.freshness) && age >= -30000 && age <= 45000; }
async function buildPredictionAnalysis({ markets = [], portfolio, metrics, balance, cpi = {} }, now = Date.now()) {
  const book = metrics?.positions || [];
  const nlv = number(metrics?.netLiquidation);
  const accountScopeVerified = (metrics?.accountIds || []).length <= 1 && (!(metrics?.accountIds || []).length || balance?.data?.current?.accountId === metrics.accountIds[0]);
  const nlvVerified = accountScopeVerified && verified(portfolio, now) && metrics?.available === true && metrics?.accountSummaryAvailable === true;
  const current = balance?.data?.current;
  const funding = number(current?.eventContracts?.availableFunds);
  const fundingVerified = verified(balance, now) && current?.capacity?.available === true && current?.capacity?.status === 'live' && ['ibkr_event_contract_commodity_segment_reconciled', 'ibkr_kalshi_commodity_segment_reconciled'].includes(current?.eventContracts?.verification);
  const held = book.filter(p => p.category === 'event_contract' && number(p.quantity) !== 0);
  const rows = [];
  let totalProposed = 0;
  const { calculateKalshiTakerFee, buildCpiAllocationModel } = await import('../../utils/cpiAllocationModel.js');
  for (const [marketId, label, venue] of MARKETS) {
    const raw = markets.find(m => m.marketId === marketId);
    const snapshot = raw?.snapshot;
    const normalized = normalizeMarket(marketId, snapshot, now);
    const contracts = snapshot?.displayContracts;
    const event = contracts?.event;
    const setupId = marketId === 'cpi' ? snapshot?.forecastComparison?.releaseKey : event?.ticker;
    const row = { marketId, label, venue, setupId, settlement: event || null, status: 'withheld', reasons: [], candidates: [], capPctNlv: marketId === 'cpi' ? 15 : 5, normalized };
    rows.push(row);
    if (!snapshot || snapshot.selectedVenueId !== venue || normalized.directBook.status !== 'available' || normalized.directBook.venueId !== venue || !setupId) { row.reasons.push('The exact current monitor, settlement, and fresh native book are required.'); continue; }
    // The existing calibrated allocation model is specific to Kalshi's native
    // contracts and fees. ForecastEx CPI is a release-matched research comparison.
    if (marketId === 'cpi' && venue !== 'kalshi') { row.reasons.push('ForecastEx CPI allocation is not supported by the Kalshi calibration model.'); continue; }
    const catalog = contracts.lines || [];
    const lineMatches = (line, position) => [line.ticker, line.contractId, line.yesConId, line.noConId].filter(v => v != null).map(String).some(id => [position.contract, position.conId, position.symbol].filter(v => v != null).map(String).includes(id));
    const matches = position => catalog.some(line => lineMatches(line, position));
    // Unknown held contracts cannot silently contribute zero setup exposure.
    const knownElsewhere = position => markets.some(m => (m.snapshot?.displayContracts?.lines || []).some(line => lineMatches(line, position)));
    const existing = held.filter(matches);
    const exposureVerified = nlvVerified && held.every(p => matches(p) || knownElsewhere(p)) && existing.every(p => number(p.costBasis) !== null && number(p.quantity) > 0);
    const existingLoss = existing.reduce((sum, p) => sum + Math.abs(number(p.costBasis) || 0), 0);
    row.existingLoss = exposureVerified ? existingLoss : null;
    if (marketId === 'cpi') {
      const cap = nlvVerified ? nlv * 0.15 : null;
      const comparison = snapshot.forecastComparison;
      const model = cpi.model || (comparison?.hedgeye?.status === 'available' ? { metric: comparison.metric, forecastMonth: comparison.forecastMonth, releaseDate: comparison.releaseAt, scenarios: comparison.hedgeye.scenarios } : null);
      const cpiRows = cpi.rows || (normalized.directBook.allLines || normalized.directBook.focusLines).filter(line => ['>', 'gt', 'above', 'greater_than'].includes(String(line.comparator).toLowerCase())).map(line => ({ id: line.ticker, threshold: line.threshold, title: `CPI Above ${line.threshold}%`, venue: 'kalshi', yesPrice: line.yesAsk, noPrice: line.noAsk, payoutMultiplier: 1, event: { id: line.ticker, venue: 'kalshi', source_api: 'KALSHI_TRADE_API_V2', updated_at: contracts.asOf, yes_bid: line.yesBid, yes_ask: line.yesAsk, no_bid: line.noBid, no_ask: line.noAsk, yes_ask_size: line.yesAskSize, no_ask_size: line.noAskSize, data_quality_flags: [] } }));
      const allocation = buildCpiAllocationModel({ model, history: cpi.history || [], finals: cpi.finals || [], rows: cpiRows, openPositions: existing.map(p => ({ ...p, threshold: number(catalog.find(line => lineMatches(line, p))?.threshold), contractSide: p.eventSide })), portfolioEquity: nlvVerified ? nlv : null, riskPct: 15, providerReady: fundingVerified && exposureVerified, currentOpenRisk: exposureVerified ? existingLoss : null, settings: { stopWhenMarginalUtilityNonpositive: true, riskPct: 15, maxRiskPerBet: cap, maxOpenRisk: cap, maxCorrelatedExposure: cap, maxPmRiskPct: 0.15 }, now });
      row.allocation = allocation;
      // Existing workbench owns calibrated probabilities and settlement scenarios.
      if (allocation.status !== 'ready') row.reasons.push(allocation.reason || 'Verified CPI calibration, live workbench contracts, or capacity is incomplete.');
      else if (!fundingVerified || !Number.isFinite(allocation.deployedBudget) || allocation.deployedBudget > funding - totalProposed || !Number.isFinite(allocation.metrics?.postTradeWorstLoss) || allocation.metrics.postTradeWorstLoss > cap) row.reasons.push('Verified funding does not cover the proposed CPI allocation.');
      else { row.status = allocation.deployedBudget > 0 ? 'qualified' : 'no qualifying lines'; row.candidates = (allocation.allocations || []).filter(a => a.contracts > 0).map(a => ({ ...a, contractId: a.row.id, nativePrice: a.ask, settlement: event, sizing: { allowed: true, contracts: a.contracts, proposedLoss: a.maxLoss, combinedLoss: allocation.metrics.postTradeWorstLoss, cap } })); totalProposed += allocation.deployedBudget; }
      continue;
    }
    if (!normalized.setup.researchQualified || normalized.reference.status !== 'available') { row.reasons.push(...normalized.setup.reasons.filter(r => !r.includes('strategy'))); continue; }
    const bullish = normalized.trade.direction === 'BULLISH';
    const side = bullish ? 'YES' : 'NO';
    const eligible = (normalized.directBook.allLines || normalized.directBook.focusLines).filter(line => {
      const threshold = number(line.threshold);
      return threshold !== null && ['>', 'gt', 'above', 'greater_than'].includes(String(line.comparator).toLowerCase()) && (bullish ? threshold <= normalized.riskRange.lrr : threshold >= normalized.riskRange.hrr);
    });
    let proposedLoss = 0;
    for (const line of eligible.slice(0, 2)) {
      const price = number(bullish ? line.yesAsk : line.noAsk);
      const depth = number(bullish ? line.yesAskSize : line.noAskSize);
      const native = catalog.find(c => c.ticker === line.ticker || c.contractId === line.ticker);
      const fee = venue === 'kalshi' && price > 0 && price < 1 ? calculateKalshiTakerFee(1, price) : number(native?.feePerContract);
      const sizing = setupCapacity({ market: marketId, nlv, nlvVerified, funding: fundingVerified ? Math.max(0, funding - totalProposed) : null, fundingVerified, existingLoss: existingLoss + proposedLoss, exposureVerified, unitLoss: price, fees: fee, proposed: depth || 0 });
      row.candidates.push({ contractId: line.ticker, side, nativePrice: price, threshold: line.threshold, comparator: line.comparator, settlement: event, rationale: `${normalized.trade.direction} Trade and Trend at the ${normalized.rangeLocation.zone}; threshold beyond the corresponding published risk-range boundary. This is a process screen, not a probability or expected return.`, sizing });
      if (sizing.allowed) { proposedLoss += sizing.proposedLoss; totalProposed += sizing.proposedLoss; }
    }
    row.status = row.candidates.some(c => c.sizing.allowed) ? 'qualified' : row.candidates.length ? 'sizing withheld' : 'no qualifying lines';
    if (!exposureVerified) row.reasons.push('Complete current setup exposure could not be verified.');
    if (!fundingVerified) row.reasons.push('Verified event-contract funding and capacity are unavailable.');
  }
  return { asOf: new Date(now).toISOString(), markets: rows, totalProposedLoss: totalProposed, policy: { setupCapPct: 5, cpiReleaseCapPct: 15, existingPlusProposed: true, execution: false, inventedProbabilities: false } };
}
module.exports = { MARKETS, buildPredictionAnalysis };
