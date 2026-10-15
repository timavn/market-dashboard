// Presentation only: the portfolio owner supplies a validated historical reference.
// Provider status, freshness, and volatility-band calculations stay upstream.
const sizingVolatilityPercent = (reference) => {
  const volatility = reference.available ? reference.band.volatility : null;
  return Number.isFinite(volatility) ? volatility * 100 : null;
};

export function buildSizingVolatilityPresentation({ symbol, reference, loading, asOfLabel }) {
  const rv = reference.rv;
  const sizingVolPct = sizingVolatilityPercent(reference);
  const badges = [];
  if (rv?.limitedHistory) badges.push('Limited history');
  if (rv?.spikeWarning) badges.push('Spike');
  const badgeText = badges.length > 0 ? ` · ${badges.join(' · ')}` : '';

  return {
    metric: {
      value: sizingVolPct != null
        ? `${sizingVolPct.toFixed(1)}%`
        : loading ? '…' : 'Unavailable',
      meta: sizingVolPct != null
        ? `max(63d, 1Y) realized · ${asOfLabel}${badgeText}`
        : reference.reason,
      title: 'Sizing uses the higher of 3-month and 1-year annualized realized volatility. Reference only — not options IV.',
      tone: 'is-muted',
      className: sizingVolPct != null ? 'is-reference' : '',
      buttonLabel: sizingVolPct != null
        ? `Verify ${symbol} sizing volatility`
        : null,
    },
    display: sizingVolPct != null ? {
      text: `${sizingVolPct.toFixed(1)}%`,
      badge: badges.length > 0 ? {
        className: rv?.spikeWarning ? 'is-spike' : 'is-limited',
        label: rv?.spikeWarning ? 'Spike' : 'Limited',
      } : null,
    } : null,
  };
}

// Called on click, as before; later renders must not rewrite an open explanation.
export function buildSizingVolatilityVerification({ symbol, reference }) {
  const rv = reference.rv;
  const sizingVolPct = sizingVolatilityPercent(reference);
  if (sizingVolPct == null) return null;

  return {
    symbol,
    metric: 'Sizing volatility',
    formula: 'SizingVol = max(RV₆₃, RV₂₅₂); RV = stdev(ln returns) × √N',
    equation: [
      `RV₆₃ = ${Number.isFinite(rv?.rv63) ? `${(rv.rv63 * 100).toFixed(2)}%` : 'n/a'}`,
      `RV₂₅₂ = ${Number.isFinite(rv?.rv252) ? `${(rv.rv252 * 100).toFixed(2)}%` : 'n/a'}`,
      `SizingVol = ${sizingVolPct.toFixed(2)}%`,
      `N = ${rv?.annualizationFactor || 252}`,
      `Observations = ${rv?.observationCount || 0}`,
    ].join(' · '),
    result: `${sizingVolPct.toFixed(2)}% annualized`,
    details: [
      ...(rv?.warnings || []),
      'Uses Yahoo adjusted closes only.',
      'Leveraged/inverse ETFs use their own price history.',
      'Reference-only / non-executable.',
    ],
  };
}
