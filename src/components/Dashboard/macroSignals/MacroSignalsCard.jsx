import { useMemo, useState } from 'react';

import AssetTabs from './AssetTabs';
import SignalSection from './SignalSection';

import './MacroSignals.css';
import { DEFAULT_ASSET_CLASS } from './constants';

function sortDescScore(a, b) {
  const sa = Number(a.score);
  const sb = Number(b.score);
  if (sb !== sa) return sb - sa;
  return String(a.ticker).localeCompare(String(b.ticker));
}

function MacroSignalsCard({
  signals,
  selectedSignal,
  onSelectSignal,
  onRefresh,
  loading,
  error,
  onRetry,
}) {
  const [activeAssetClass, setActiveAssetClass] = useState(DEFAULT_ASSET_CLASS);

  const selectedId =
    selectedSignal && typeof selectedSignal === 'object' && selectedSignal.symbol
      ? String(selectedSignal.symbol).toLowerCase()
      : null;

  const partitioned = useMemo(() => {
    const tabSignals = signals.filter(
      s => s.assetClass === activeAssetClass && (s.side === 'long' || s.side === 'short')
    );
    const longs = tabSignals.filter(s => s.side === 'long').sort(sortDescScore);
    const shorts = tabSignals.filter(s => s.side === 'short').sort(sortDescScore);
    return { longs, shorts, tabEmpty: tabSignals.length === 0 };
  }, [signals, activeAssetClass]);

  const runRefresh = () => {
    if (typeof onRefresh === 'function') onRefresh();
    else if (typeof onRetry === 'function') onRetry();
  };

  const showSkeleton = loading && partitioned.tabEmpty && !error;

  return (
    <aside className="macro-signals-card" aria-labelledby="macro-signals-title-heading">
      <div className="macro-signals-header-row macro-signals-header">
        <h2 className="macro-signals-title" id="macro-signals-title-heading">
          Macro Signals
        </h2>
        <button type="button" className="macro-signals-refresh" onClick={runRefresh} title="Refresh data">
          <span className="macro-signals-refresh-icon">↻</span>
          Refresh
        </button>
      </div>
      <div className="macro-signals-header-divider" />

      <AssetTabs activeAssetClass={activeAssetClass} onChange={setActiveAssetClass} />

      {error && (
        <div className="macro-signals-error" role="alert">
          <span>{error}</span>
          <button type="button" className="macro-signals-refresh" onClick={runRefresh}>
            Retry
          </button>
        </div>
      )}

      <div className="macro-signals-body macro-signals-rows">
        {showSkeleton ? (
          <div className="macro-signals-empty">Loading signals…</div>
        ) : partitioned.tabEmpty && !loading ? (
          <div className="macro-signals-empty">No signals for this asset class.</div>
        ) : (
          <>
            <SignalSection
              variant="long"
              title="LONGS"
              signals={partitioned.longs}
              activeId={selectedId}
              onSelectSignal={onSelectSignal}
            />
            <SignalSection
              variant="short"
              title="SHORTS"
              signals={partitioned.shorts}
              activeId={selectedId}
              onSelectSignal={onSelectSignal}
            />
          </>
        )}
      </div>

      <div className="info-note" role="note">
        <span className="info-note-icon" aria-hidden>
          i
        </span>
        <div className="info-note-body">
          Range shows our 7–30 day forecast window. Live spot reflects the latest market price.
        </div>
      </div>
    </aside>
  );
}

export default MacroSignalsCard;
