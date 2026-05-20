import SectionIcon from './SectionIcon';
import SignalRow from './SignalRow';

function SignalSection({
  variant,
  title,
  signals,
  activeId,
  onSelectSignal,
  rangeHeading,
}) {
  const count = signals.length;
  const heading = rangeHeading ?? 'Range';

  return (
    <section
      className={`signal-section signal-section-${variant}`}
      aria-labelledby={`macro-section-${variant}`}
    >
      <div className="signal-section-header">
        <span className={`signal-section-icon signal-section-icon-${variant}`}>
          <SectionIcon
            variant={variant === 'short' ? 'short' : variant === 'neutral' ? 'neutral' : 'long'}
          />
        </span>
        <span className="signal-section-heading" id={`macro-section-${variant}`}>
          {title}
        </span>
        <span className="signal-count-badge">{count}</span>
      </div>

      <div className="signal-table">
        <div className="signal-header" role="row">
          <span>Ticker</span>
          <span className="signal-range-heading">{heading}</span>
          <span className="signal-table-header-span-center">Trade</span>
          <span className="signal-table-header-span-center">Trend</span>
          <span className="signal-table-header-span-center">Downside</span>
          <span className="signal-table-header-span-center">Upside</span>
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
