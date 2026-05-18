import RangeWidget from './RangeWidget';
import TrendIcon from './TrendIcon';

function TradePill({ trade }) {
  if (!trade) {
    return <span className="trade-pill trade-pill-neutral">—</span>;
  }
  const cls =
    trade === 'Sell'
      ? 'trade-pill-sell'
      : trade === 'Buy'
        ? 'trade-pill-buy'
        : 'trade-pill-neutral';
  return <span className={`trade-pill ${cls}`}>{trade}</span>;
}

function SignalRow({ signal, active, onSelectSignal }) {
  const tone = signal.side === 'short' ? 'red' : 'green';

  const handleClick = () => {
    if (typeof onSelectSignal === 'function') onSelectSignal(signal);
  };

  return (
    <button
      type="button"
      className={`signal-row ${active ? 'signal-row-active' : ''}`}
      onClick={handleClick}
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
        <TradePill trade={signal.trade} />
      </div>
      <div className="signal-cell-center">
        <TrendIcon trend={signal.trend} />
      </div>
      <div className="signal-cell-center">
        <span className={signal.tail ? 'signal-tail-text' : 'signal-dash'}>
          {signal.tail || '—'}
        </span>
      </div>
    </button>
  );
}

export default SignalRow;
