function isCashHolding(holding) {
  const secType = (holding.secType || holding.assetType || '').toUpperCase();
  const assetClass = (holding.assetClass || '').toLowerCase();
  return (
    secType === 'CASH' ||
    assetClass === 'cash' ||
    holding.symbol === 'Cash & Cash Investments'
  );
}

/**
 * Macro long/short exposure snapshot from IBKR holdings + account summary.
 * @param {{ holdings?: object[], accountSummary?: object|null, summary?: object|null }} input
 */
export function computePortfolioExposure({ holdings = [], accountSummary = null, summary = null }) {
  let longMV = 0;
  let shortMV = 0;
  let netMV = 0;

  for (const h of holdings) {
    if (isCashHolding(h)) continue;

    const qty = Number(h.quantity) || 0;
    const mv = Number(h.marketValue);
    if (!Number.isFinite(mv)) continue;

    if (qty > 0 || mv > 0) {
      longMV += Math.abs(mv);
      netMV += mv;
    } else if (qty < 0 || mv < 0) {
      shortMV += Math.abs(mv);
      netMV += mv;
    }
  }

  const cashValue =
    accountSummary?.totalCashValue != null ? Number(accountSummary.totalCashValue) : null;

  let nlv =
    accountSummary?.netLiquidation != null
      ? Number(accountSummary.netLiquidation)
      : summary?.totalValue != null
        ? Number(summary.totalValue)
        : null;

  if (!nlv || nlv <= 0) {
    nlv = longMV + shortMV + (cashValue || 0);
  }

  if (!nlv || nlv <= 0) {
    return {
      grossPct: null,
      netPct: null,
      longPct: null,
      shortPct: null,
      cashPct: null,
      nlv: null,
      longMV,
      shortMV,
      netMV,
      cashValue,
      hasData: false,
    };
  }

  return {
    grossPct: ((longMV + shortMV) / nlv) * 100,
    netPct: (netMV / nlv) * 100,
    longPct: (longMV / nlv) * 100,
    shortPct: (shortMV / nlv) * 100,
    cashPct: cashValue != null ? (cashValue / nlv) * 100 : null,
    nlv,
    longMV,
    shortMV,
    netMV,
    cashValue,
    hasData: true,
  };
}

export function formatExposurePct(value, { signed = false } = {}) {
  if (value == null || !Number.isFinite(value)) return '—';
  const rounded = Math.round(value);
  if (signed && rounded > 0) return `+${rounded}%`;
  return `${rounded}%`;
}

export function formatCurrency(value, currency = 'USD') {
  if (value == null || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}
