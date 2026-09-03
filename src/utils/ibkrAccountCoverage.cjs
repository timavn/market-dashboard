function normalizedAccountIds(accounts = []) {
  return [...new Set((Array.isArray(accounts) ? accounts : [])
    .map((account) => String(account?.accountId || account?.account || account || '').trim())
    .filter(Boolean))].sort();
}

function expectedIbkrAccountIds(env = process.env) {
  const contractPnlAccount = String(
    env.PREDICTION_MARKET_PERFORMANCE_ACCOUNT_ID
      || env.IBKR_ACCOUNT_ID
      || env.IBKR_FLEX_EXPECTED_ACCOUNT_ID
      || '',
  ).trim();
  return contractPnlAccount ? normalizedAccountIds([contractPnlAccount]) : [];
}

function buildIbkrAccountCoverage(
  marketStatus = {},
  portfolioStatus = {},
  observedAt = new Date().toISOString(),
  expected = expectedIbkrAccountIds(),
) {
  const expectedAccounts = normalizedAccountIds(expected);
  const liveDiscoveryAvailable = marketStatus?.ibkr?.connected === true
    || portfolioStatus?.ibkr?.connected === true;
  const connected = normalizedAccountIds([
    ...(marketStatus?.ibkr?.connected === true ? marketStatus.ibkr.accounts || [] : []),
    ...(portfolioStatus?.ibkr?.connected === true ? portfolioStatus.ibkr.accounts || [] : []),
  ]);
  const targets = expectedAccounts.length ? expectedAccounts : connected;
  const missingLiveAccounts = targets.filter((accountId) => !connected.includes(accountId));
  const complete = targets.length > 0 && missingLiveAccounts.length === 0;
  return {
    status: complete
      ? 'complete'
      : (liveDiscoveryAvailable && targets.length ? 'partial_account_coverage' : 'unavailable'),
    complete,
    expected: targets,
    expectedAccountIds: targets,
    connected,
    connectedAccountIds: connected,
    missingLiveAccounts,
    missingLiveAccountIds: missingLiveAccounts,
    observedAt,
    timestamp: observedAt,
  };
}

module.exports = {
  buildIbkrAccountCoverage,
  expectedIbkrAccountIds,
  normalizedAccountIds,
};
