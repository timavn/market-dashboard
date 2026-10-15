// Presentation only. The parent accepts broker/ATR inputs, calculates the
// reference and its tone, and supplies formatted currency/date labels.
export function buildStopLossPresentation({ symbol, isShort, hasAtr, reference }) {
  const available = reference !== null;
  const operator = isShort ? '+' : '−';

  return {
    metric: {
      value: available ? reference.value.toFixed(2) : '—',
      meta: available
        ? `IBKR basis · 2×ATR14 · ${reference.asOfLabel} · reference only`
        : hasAtr ? 'Verified IBKR average cost required' : 'ATR14 reference unavailable',
      title: available
        ? 'Non-executable reference: IBKR average cost adjusted by two historical ATR14 values.'
        : 'A stop reference requires verified IBKR average cost and historical ATR14.',
      tone: available ? reference.tone : 'is-muted',
      className: available ? 'is-reference' : '',
      buttonLabel: `Verify ${symbol} stop loss calculation`,
    },
    verification: {
      symbol,
      metric: 'Stop loss',
      formula: isShort
        ? 'Stop = average cost + (2 × ATR14)'
        : 'Stop = average cost − (2 × ATR14)',
      equation: available
        ? `${reference.averageCostLabel} ${operator} (2 × ${reference.atrLabel}) = ${reference.resultLabel}`
        : 'Not calculated — verified IBKR average cost and ATR14 are required.',
      result: available ? reference.resultLabel : 'Unavailable',
      details: available
        ? [
          `${isShort ? 'Short' : 'Long'} position`,
          'Verified IBKR average cost',
          `ATR14 through ${reference.asOfLabel}`,
        ]
        : ['No executable stop is created; this is a reference check only.'],
    },
  };
}
