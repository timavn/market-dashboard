import RangeWidget from './RangeWidget';
import SignalArrow from './TrendIcon';
import { formatRiskRangePercent } from '../../../utils/riskRangePercents';

/** Returns true if spot price is in the outer thirds of the forecast range (action zones). */
function isInActionZone(signal) {
  const { forecastLow: low, forecastHigh: high, spotPrice: spot } = signal;
  if (!Number.isFinite(low) || !Number.isFinite(high) || !Number.isFinite(spot)) return false;
  const span = high - low;
  if (span <= 0) return false;
  const pct = ((spot - low) / span) * 100;
  return pct <= 33.3 || pct >= 66.7;
}

/** Returns true if spot price is outside the forecast range entirely. */
function isOutOfRange(signal) {
  const { forecastLow: low, forecastHigh: high, spotPrice: spot } = signal;
  if (!Number.isFinite(low) || !Number.isFinite(high) || !Number.isFinite(spot)) return false;
  return spot < low || spot > high;
}

function SignalRow({ signal, active, onSelectSignal }) {
  const tone = signal.side === 'short' ? 'red' : signal.side === 'long' ? 'green' : 'neutral';
  const sideClass = signal.side === 'short' ? 'short' : signal.side === 'long' ? 'long' : 'neutral';

  const breakout = isOutOfRange(signal);
  const actionZone = !breakout && isInActionZone(signal);

  let rowClasses = 'signal-row';
  if (active) rowClasses += ' signal-row-active';
  if (breakout) rowClasses += ' signal-row-breakout';
  else if (actionZone) rowClasses += ` signal-row-action-${sideClass}`;

  const handleClick = () => {
    if (typeof onSelectSignal === 'function') onSelectSignal(signal);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      className={rowClasses}
      onClick={handleClick}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') handleClick(); }}
    >
      <div className="signal-ticker-stack">
        <span className="signal-ticker">{signal.ticker}</span>
        <span className="signal-name">{signal.name}</span>
      </div>
      <div className="signal-cell-range">
        <RangeWidget
          low={signal.forecastLow}
          high={signal.forecastHigh}
          spot={signal.spotPrice}
          tone={tone}
          canonical={signal.canonical}
        />
      </div>
      <div className="signal-cell-center">
        <SignalArrow value={signal.trade} />
      </div>
      <div className="signal-cell-center">
        <SignalArrow value={signal.trend} />
      </div>
      <div className="signal-cell-center">
        <span
          className={`signal-pct signal-pct-downside${
            signal.downsidePct != null && signal.downsidePct < 0 ? ' signal-pct-negative' : ''
          }`}
        >
          {formatRiskRangePercent(signal.downsidePct)}
        </span>
      </div>
      <div className="signal-cell-center">
        <span
          className={`signal-pct signal-pct-upside${
            signal.upsidePct != null && signal.upsidePct > 0 ? ' signal-pct-positive' : ''
          }`}
        >
          {formatRiskRangePercent(signal.upsidePct)}
        </span>
      </div>
    </div>
  );
}

export { isInActionZone, isOutOfRange };
export default SignalRow;
