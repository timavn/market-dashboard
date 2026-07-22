/**
 * Map normalized ingest event → v2 dashboard row shape.
 * Passes through quote/market fields used by ContractMapCard while keeping
 * legacy yes/no mids for TradePlanCard.
 */
function normalizedToDashboardEvent(event, userContract = null) {
  const finiteOrNull = (value) => (
    value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
      ? Number(value)
      : null
  );
  const yes = finiteOrNull(event.yes_mid);
  const no = finiteOrNull(event.no_mid);
  return {
    ...event,
    id: event.id,
    question: event.question || event.contract_title || event.event_title,
    category: event.category || 'Other Macro',
    settle: event.event_date || event.close_time?.slice(0, 10) || '—',
    yes,
    no,
    myProb: userContract?.adjustedProbability ?? userContract?.myProbability ?? null,
    side: userContract?.contractSide || null,
    sizeUsd: 0,
    payoutMultiplier: finiteOrNull(event.max_payout_per_contract),
    normalized: event,
    contract: userContract,
  };
}

module.exports = { normalizedToDashboardEvent };
