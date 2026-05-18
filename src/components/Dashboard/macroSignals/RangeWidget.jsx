import { formatBoundaryForAsset, formatSpotDisplayForAsset } from './formatNumber';

/**
 * Forecast band + live spot — dot uses clampedPct; label clamps to 0–100 to avoid overflow.
 */
function RangeWidget({ low, high, spot, tone, canonical }) {
  const sideClass = tone === 'red' ? 'short' : 'long';

  if (low == null || high == null || !Number.isFinite(low) || !Number.isFinite(high)) {
    return (
      <div className="range-widget range-widget-muted">
        <span>—</span>
      </div>
    );
  }

  const span = high - low;
  let rawPct = 50;
  if (Number.isFinite(spot) && span !== 0) {
    rawPct = ((spot - low) / span) * 100;
  } else if (span === 0 && Number.isFinite(spot)) {
    rawPct = spot <= low ? 0 : 100;
  }

  const clampedPct = Math.max(-8, Math.min(108, rawPct));
  const labelPct = Math.max(0, Math.min(100, clampedPct));

  const fmtLow = formatBoundaryForAsset(low, canonical);
  const fmtHigh = formatBoundaryForAsset(high, canonical);
  const spotFmt = Number.isFinite(spot) ? formatSpotDisplayForAsset(spot, canonical) : null;

  return (
    <div className="range-widget">
      <div className="range-labels">
        <span className="range-label range-label-low">{fmtLow}</span>
        <span className="range-label range-label-high">{fmtHigh}</span>
      </div>

      <div className="range-track-wrap">
        <span className="range-tick range-tick-left" aria-hidden />
        <span className="range-track" aria-hidden />
        <span className="range-tick range-tick-right" aria-hidden />
        <span
          className={`range-dot ${sideClass}`}
          style={{ left: `${clampedPct}%` }}
          aria-hidden
        />
      </div>

      {spotFmt != null && (
        <div className="range-spot" style={{ left: `${labelPct}%` }}>
          <div className={`range-spot-price ${sideClass}`}>{spotFmt}</div>
          <div className="range-spot-caption">Live Spot</div>
        </div>
      )}
    </div>
  );
}

export default RangeWidget;
