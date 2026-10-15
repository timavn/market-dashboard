// Presentation only: mapping, source acceptance, period selection and date formatting stay upstream.
export function buildUsdCorrelationPresentation({ proxy, correlation, loading, asOfLabel }) {
  return {
    value: !proxy
      ? 'N/A'
      : correlation === null
        ? loading ? '…' : 'Unavailable'
        : `${correlation > 0 ? '+' : ''}${correlation.toFixed(2)}`,
    meta: !proxy
      ? 'No direct USD proxy'
      : correlation === null
        ? `DXY vs ${proxy} unavailable`
        : `DXY vs ${proxy} · 30D · ${asOfLabel}`,
    tone: correlation !== null && correlation > 0
      ? 'is-positive'
      : correlation !== null && correlation < 0 ? 'is-negative' : 'is-muted',
  };
}
