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
    let mv = Number(h.marketValue);
    if (!Number.isFinite(mv)) {
      const price = Number(h.price) || Number(h.avgCost) || 0;
      if (qty !== 0 && price) {
        mv = qty * price;
      }
    }
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

export function formatSignedCurrency(value, currency = 'USD') {
  if (value == null || !Number.isFinite(value)) return '—';
  const abs = formatCurrency(Math.abs(value), currency);
  if (value > 0) return `+${abs}`;
  if (value < 0) return `-${abs}`;
  return abs;
}

/**
 * Daily P&L % vs prior close: dailyPnL / (NLV - dailyPnL).
 */
export function computeDailyPnLPercent(dailyPnL, nlv) {
  if (dailyPnL == null || nlv == null || !Number.isFinite(dailyPnL) || !Number.isFinite(nlv)) {
    return null;
  }
  const priorClose = nlv - dailyPnL;
  if (!priorClose || priorClose <= 0) return null;
  return (dailyPnL / priorClose) * 100;
}

function pickSummaryNumber(raw, key) {
  const v = raw?.[key];
  return v != null && !Number.isNaN(Number(v)) ? Number(v) : null;
}

/**
 * Liquidity and margin metrics from IBKR account summary.
 */
export function computeMarginMetrics(accountSummary) {
  if (!accountSummary) {
    return {
      hasData: false,
      excessLiquidity: null,
      availableFunds: null,
      marginUsed: null,
      marginCushionPct: null,
      healthLabel: null,
    };
  }

  const nlv = pickSummaryNumber(accountSummary, 'netLiquidation');
  const excessLiquidity = pickSummaryNumber(accountSummary, 'excessLiquidity');
  const availableFunds = pickSummaryNumber(accountSummary, 'availableFunds');
  const marginUsed = pickSummaryNumber(accountSummary, 'initialMargin');
  const maintMargin = pickSummaryNumber(accountSummary, 'maintenanceMargin');

  let marginCushionPct = null;
  if (excessLiquidity != null && nlv != null && nlv > 0) {
    marginCushionPct = (excessLiquidity / nlv) * 100;
  } else if (nlv != null && nlv > 0 && maintMargin != null) {
    marginCushionPct = ((nlv - maintMargin) / nlv) * 100;
  }

  let healthLabel = null;
  if (marginCushionPct != null) {
    if (marginCushionPct >= 25) healthLabel = 'Healthy';
    else if (marginCushionPct >= 15) healthLabel = 'Moderate';
    else healthLabel = 'Low';
  }

  return {
    hasData: nlv != null && nlv > 0,
    excessLiquidity,
    availableFunds,
    marginUsed,
    marginCushionPct,
    healthLabel,
  };
}

export const IDLE_CASH_TOOLTIP =
  'Idle cash as % of NLV (IBKR TotalCashValue). Fully deployed margin accounts often show 0%.';
