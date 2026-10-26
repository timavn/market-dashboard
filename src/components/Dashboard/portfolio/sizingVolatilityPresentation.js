// Presentation only: the portfolio owner supplies a validated historical reference.
// Provider status, freshness, and ATR-band calculations stay upstream.
const sizingAtrPercent = (reference) => {
  const relativeAtr = reference.available ? reference.relativeAtr : null;
  return Number.isFinite(relativeAtr) ? relativeAtr * 100 : null;
};

export function buildSizingVolatilityPresentation({ symbol, reference, loading, asOfLabel }) {
  const atrPct = sizingAtrPercent(reference);
  const floorText = reference.floorApplied ? ' · 1.25% floor' : '';

  return {
    metric: {
      value: atrPct != null
        ? `${atrPct.toFixed(2)}%`
        : loading ? '…' : 'Unavailable',
      meta: atrPct != null
        ? `ATR14 ÷ close · ${asOfLabel}${floorText}`
        : reference.reason,
      title: 'Sizing uses the 14-day ATR as a share of the last completed close. Reference only — not options IV.',
      tone: 'is-muted',
      className: atrPct != null ? 'is-reference' : '',
      buttonLabel: atrPct != null
        ? `Verify ${symbol} sizing ATR`
        : null,
    },
    display: atrPct != null ? {
      text: `${atrPct.toFixed(2)}%`,
      badge: reference.floorApplied ? { className: 'is-limited', label: 'Floor' } : null,
    } : null,
  };
}

// Called on click, as before; later renders must not rewrite an open explanation.
export function buildSizingVolatilityVerification({ symbol, reference }) {
  const atrPct = sizingAtrPercent(reference);
  if (atrPct == null) return null;

  return {
    symbol,
    metric: 'Sizing ATR',
    formula: 'ATR % = ATR14 ÷ close; stop distance = 2 × ATR %',
    equation: [
      `ATR14 = ${reference.atr14.value.toFixed(2)}`,
      `Close = ${reference.referencePrice.value.toFixed(2)}`,
      `ATR % = ${atrPct.toFixed(2)}%`,
      `Stop distance = ${(reference.stopDistance * 100).toFixed(2)}%`,
    ].join(' · '),
    result: `${atrPct.toFixed(2)}% of price`,
    details: [
      ...(reference.floorApplied ? ['Below the 1.25% floor: the floor sets MIN / MAX; the stop uses the measured ATR.'] : []),
      `Completed daily bars through ${reference.asOf}.`,
      'Leveraged/inverse ETFs use their own price history.',
      'Reference-only / non-executable.',
    ],
  };
}
