const accountIds = new Set(['portfolio', 'portfolioBalance', 'portfolioOpenOrders', 'balance']);
const accountLabel = /^IBKR (?:holdings|balances|open orders|account exposure)$/i;
const disconnectedCodes = new Set(['IBKR_GATEWAY_NOT_CONNECTED', 'IBKR_GATEWAY_NOT_AUTHENTICATED', 'GATEWAY_UNAVAILABLE']);
// Unverified checks failed without establishing a disconnect.
const gatewayCodes = new Set([...disconnectedCodes, 'IBKR_GATEWAY_READINESS_TIMEOUT', 'IBKR_SERVICE_UNAVAILABLE', 'IBKR_GATEWAY_NOT_VERIFIED',
  'IBKR_GATEWAY_RECONNECTING', 'IBKR_GATEWAY_API_UNRESPONSIVE', 'IBKR_CLIENT_ID_IN_USE', 'IBKR_GATEWAY_CONNECTION_UNVERIFIED']);
// A settled capture whose connection check never ran.
const notCheckedCodes = new Set(['SOURCE_NOT_ATTEMPTED', 'SOURCE_CHECK_INCOMPLETE']);
const validTime = value => typeof value === 'string'
  && /^(?:\d{4}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))$/i.test(value)
  && Number.isFinite(Date.parse(value));
const unsafe = item => item.connected === false
  || ['stale', 'isStale', 'cached', 'cacheOnly', 'cachedOnly', 'fromCache', 'mock', 'isMock', 'seed', 'seeded', 'synthetic', 'inferred', 'fallback', 'refreshFailed', 'disconnected'].some(key => item[key] === true);
const verified = item => item.status === 'ready' && validTime(item.observedAt) && !unsafe(item);

function gatewayItem(explicit, accounts) {
  // A captured connection check is independent of whether an account request
  // succeeds. Never replace its clock with today's status or a report clock.
  let captured = explicit;
  if (!captured) {
    const failed = accounts.find(item => gatewayCodes.has(item.diagnostic?.code));
    const ready = accounts.filter(verified).sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt))[0];
    // Account requests a settled capture never made leave the connection
    // unchecked, unless one was skipped because its check was unverified.
    const unchecked = accounts.every(item => item.status === 'missing'
      && item.diagnostic?.code !== 'IBKR_CONNECTION_UNVERIFIED_NOT_ATTEMPTED');
    // Only a settled run's rows say why; readiness rows before any run carry no code.
    const settled = unchecked && accounts.find(item => notCheckedCodes.has(item.diagnostic?.code));
    captured = failed || ready || { status: accounts.some(item => item.status === 'checking') ? 'checking' : unchecked ? 'missing' : 'unavailable',
      ...(settled ? { diagnostic: { code: settled.diagnostic.code } } : {}) };
  }
  const notChecked = notCheckedCodes.has(captured.diagnostic?.code) ? captured.diagnostic : null;
  const status = verified(captured) ? 'ready' : captured.status === 'checking' ? 'checking'
    : captured.status === 'missing' && (notChecked || !captured.diagnostic?.code) ? 'missing' : 'unavailable';
  const code = gatewayCodes.has(captured.diagnostic?.code) ? captured.diagnostic.code : null;
  const disconnected = status === 'unavailable' && disconnectedCodes.has(code);
  // Only the explicit connection check timed itself; a row derived from the
  // account requests never borrows their durations.
  const elapsedMs = captured === explicit && ['ready', 'unavailable'].includes(status) && Number.isSafeInteger(explicit.elapsedMs)
    && explicit.elapsedMs >= 0 && explicit.elapsedMs <= 600_000 ? explicit.elapsedMs : null;
  return {
    id: 'ibGateway', label: 'IB Gateway', status,
    ...(elapsedMs !== null ? { elapsedMs } : {}),
    observedAt: status === 'ready' ? captured.observedAt : null,
    requiresIbGateway: true,
    ...(status === 'unavailable' ? { connectionState: disconnected ? 'disconnected' : 'unverified' } : {}),
    detail: status === 'ready' ? 'IB Gateway connection verified when this review was captured.'
      : status === 'checking' ? 'Checking the IB Gateway connection.'
        : status === 'missing' ? (notChecked ? 'This review settled before checking the IB Gateway connection.'
          : 'The IB Gateway connection has not been checked for this review.')
          : disconnected ? 'IB Gateway was disconnected or unauthenticated when this review was captured.'
            : 'This review did not establish the IB Gateway connection.',
    ...(status === 'missing' ? { diagnostic: {
      code: notChecked?.code || 'SOURCE_NOT_ATTEMPTED',
      reason: notChecked?.reason || (notChecked ? 'The IB Gateway connection was not checked before this review settled.'
        : 'The IB Gateway connection has not been checked for this review.') + ' This does not establish a disconnect.',
      remedy: notChecked?.remedy || 'Refresh this review to check the IB Gateway connection.',
    } } : {}),
    ...(status === 'unavailable' ? { diagnostic: {
      code: code || 'IBKR_GATEWAY_CONNECTION_UNVERIFIED',
      reason: gatewayCodes.has(code) && captured.diagnostic?.reason
        ? captured.diagnostic.reason
        : disconnected ? 'IB Gateway was disconnected or unauthenticated when this review was captured.'
          : 'The connection could not be verified. A failed account request alone does not establish a disconnect.',
      remedy: gatewayCodes.has(code) && captured.diagnostic?.remedy
        ? captured.diagnostic.remedy : 'Verify IB Gateway in Systems, then refresh this review.',
    } } : {}),
  };
}

// Keep per-request evidence in the captured API payload for data validation and
// diagnostics. The shared Sources table presents the broker connection once.
function reviewSourceDisplayItems(items = []) {
  const captured = [...new Map(items.filter(item => item?.id && item?.label).map(item => [item.id, item])).values()];
  const accounts = captured.filter(item => accountIds.has(item.id) || accountLabel.test(item.label));
  const explicit = captured.find(item => item.id === 'ibGateway');
  if (!explicit && !accounts.length) return captured;
  const hidden = new Set(accounts.map(item => item.id));
  const gateway = gatewayItem(explicit, accounts);
  let inserted = false;
  return captured.flatMap(item => {
    if (item.id !== 'ibGateway' && !hidden.has(item.id)) return [item];
    if (inserted) return [];
    inserted = true;
    return [gateway];
  });
}

module.exports = { reviewSourceDisplayItems };
