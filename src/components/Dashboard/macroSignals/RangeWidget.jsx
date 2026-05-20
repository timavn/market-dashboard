import { formatBoundaryForAsset, formatSpotDisplayForAsset } from './formatNumber';

function RangeWidget({ low, high, spot, tone, canonical }) {
  const sideClass = tone === 'red' ? 'short' : tone === 'neutral' ? 'neutral' : 'long';

  if (low == null || high == null || !Number.isFinite(low) || !Number.isFinite(high)) {
    return (
      <div className="range-sparkline range-widget-muted">
        <span>—</span>
      </div>
    );
  }

  const span = high - low;
  const rawPct = Number.isFinite(spot) && span !== 0 ? ((spot - low) / span) * 100 : 50;
  const dotPct = Math.max(0, Math.min(100, rawPct));
  const outOfRange = Number.isFinite(spot) && (spot < low || spot > high);

  const dotClass = `range-dot ${sideClass}${outOfRange ? ' range-dot-alert' : ''}`;
  const priceClass = `range-spot-price ${sideClass}${outOfRange ? ' range-spot-alert' : ''}`;

  const fmtLow = formatBoundaryForAsset(low, canonical);
  const fmtHigh = formatBoundaryForAsset(high, canonical);
  const spotFmt = Number.isFinite(spot) ? formatSpotDisplayForAsset(spot, canonical) : null;

  return (
    <div className="range-sparkline" style={{ '--spot-pct': `${dotPct}%` }}>
      <div className="range-boundary-labels">
        <span className="range-low">{fmtLow}</span>
        <span className="range-high">{fmtHigh}</span>
      </div>

      <div className="range-line-wrap">
        <div className={`range-zone-track ${sideClass}`}>
          <span className="range-zone range-zone-left" />
          <span className="range-zone range-zone-middle" />
          <span className="range-zone range-zone-right" />
        </div>
        <span className="range-end-tick range-end-tick-left" aria-hidden />
        <span className="range-line" aria-hidden />
        <span className="range-end-tick range-end-tick-right" aria-hidden />
        <span className={dotClass} aria-hidden />
      </div>

      {spotFmt != null && (
        <div className={priceClass}>
          {spotFmt}
        </div>
      )}
    </div>
  );
}

export default RangeWidget;
