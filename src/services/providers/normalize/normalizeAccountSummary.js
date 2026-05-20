/**
 * @param {object} raw - sidecar summary object (IB tag keys)
 */
function normalizeAccountSummary(raw) {
  const pick = (key) => {
    const v = raw[key];
    return v != null && !Number.isNaN(Number(v)) ? Number(v) : null;
  };

  return {
    accountId: raw.account || raw.accountId || null,
    currency: raw.currency || 'USD',
    netLiquidation: pick('NetLiquidation'),
    totalCashValue: pick('TotalCashValue'),
    settledCash: pick('SettledCash'),
    buyingPower: pick('BuyingPower'),
    equityWithLoanValue: pick('EquityWithLoanValue'),
    initialMargin: pick('InitMarginReq'),
    maintenanceMargin: pick('MaintMarginReq'),
    availableFunds: pick('AvailableFunds'),
    excessLiquidity: pick('ExcessLiquidity'),
    sma: pick('SMA'),
    accruedCash: pick('AccruedCash'),
    lastUpdated: raw.fetched_at || null,
  };
}

module.exports = { normalizeAccountSummary };
