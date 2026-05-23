/**
 * Map normalized ingest event → v2 dashboard row shape.
 * Passes through quote/market fields used by ContractMapCard while keeping
 * legacy yes/no mids for TradePlanCard.
 */
function normalizedToDashboardEvent(event, userContract = null) {
  const yes = event.yes_mid ?? event.last_price ?? event.yes_bid ?? 0;
  const no = event.no_mid ?? event.no_bid ?? 1 - yes;
  return {
    ...event,
    id: event.id,
    question: event.question || event.contract_title || event.event_title,
    category: event.category || 'Other Macro',
    settle: event.event_date || event.close_time?.slice(0, 10) || '—',
    yes: Number(yes) || 0,
    no: Number(no) || 0,
    myProb: userContract?.adjustedProbability ?? userContract?.myProbability ?? null,
    side: userContract?.contractSide || 'Yes',
    sizeUsd: 0,
    payoutMultiplier: event.max_payout_per_contract || 1,
    normalized: event,
    contract: userContract,
  };
}

module.exports = { normalizedToDashboardEvent };
