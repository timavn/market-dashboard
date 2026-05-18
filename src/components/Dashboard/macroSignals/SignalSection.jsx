import SectionIcon from './SectionIcon';
import SignalRow from './SignalRow';
import { MACRO_RANGE_INFO } from './constants';

function SignalSection({
  variant,
  title,
  signals,
  activeId,
  onSelectSignal,
  rangeHeading,
}) {
  const count = signals.length;
  const heading = rangeHeading ?? 'Range (Live Spot)';
  const help = MACRO_RANGE_INFO;

  return (
    <section
      className={`signal-section signal-section-${variant}`}
      aria-labelledby={`macro-section-${variant}`}
    >
      <div className="signal-section-header">
        <span className={`signal-section-icon signal-section-icon-${variant}`}>
          <SectionIcon variant={variant === 'short' ? 'short' : 'long'} />
        </span>
        <span className="signal-section-heading" id={`macro-section-${variant}`}>
          {title}
        </span>
        <span className="signal-count-badge">{count}</span>
      </div>

      <div className="signal-table">
        <div className="signal-table-header" role="row">
          <span>Ticker</span>
          <span className="signal-range-heading">
            {heading}
            <abbr className="signal-range-help" title={help}>
              i
            </abbr>
          </span>
          <span className="signal-table-header-span-center">Trade</span>
          <span className="signal-table-header-span-center">Trend</span>
          <span className="signal-table-header-span-center">Tail</span>
        </div>
        {count === 0 ? (
          <div className="signal-section-empty">No signals</div>
        ) : (
          signals.map(s => (
            <SignalRow
              key={s.id}
              signal={s}
              active={activeId === s.id}
              onSelectSignal={onSelectSignal}
            />
          ))
        )}
      </div>
    </section>
  );
}

export default SignalSection;
