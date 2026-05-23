import React, { useMemo, useState, useCallback } from 'react';
import { BarChart2, Info } from 'lucide-react';
import RefreshButton from '../../common/RefreshButton';
import LoadingIndicator from '../../common/LoadingIndicator';
import StatusDot from '../../common/StatusDot';
import Pmv2CardChrome from '../Pmv2CardChrome';
import AssetTabs from './AssetTabs';
import SignalSection from './SignalSection';
import { isInActionZone, isOutOfRange } from './SignalRow';
import { DEFAULT_MOCK_SIGNALS, DEFAULT_ASSET_CLASS } from './constants';
import {
  buildMacroUploadSources,
  deriveMacroUploadAggregateStatus,
  deriveMacroUploadUpdatedAt,
} from './macroSignalUploadStatus';
import './MacroSignals.css';

/** Tier weight for sorting: breakout (2) > action zone (1) > normal (0). */
function signalPriority(s) {
  if (isOutOfRange(s)) return 2;
  if (isInActionZone(s)) return 1;
  return 0;
}

function compareUpsidePct(a, b) {
  const au = a.upsidePct;
  const bu = b.upsidePct;
  if (au == null && bu == null) return 0;
  if (au == null) return 1;
  if (bu == null) return -1;
  return bu - au;
}

function hasForecastRange(signal) {
  const { forecastLow: low, forecastHigh: high } = signal;
  return Number.isFinite(low) && Number.isFinite(high);
}

function MacroSignalsCard({
  signals,
  selectedSignal,
  onSelectSignal,
  loading = false,
  error = null,
  onRefresh,
  uploadFreshness = null,
}) {
  const [selectedAssetClass, setSelectedAssetClass] = useState(DEFAULT_ASSET_CLASS);

  // Use provided signals or fall back to built-in mocks
  const effectiveSignals = signals && signals.length > 0 ? signals : DEFAULT_MOCK_SIGNALS;

  // Filter by selected asset-class tab
  const filteredSignals = useMemo(
    () => effectiveSignals.filter(s => s.assetClass === selectedAssetClass),
    [effectiveSignals, selectedAssetClass],
  );

  // Derive the currently-active signal ID from the parent's selectedSignal
  const activeId = useMemo(() => {
    if (!selectedSignal) return null;
    const sym = selectedSignal.symbol;
    // Match against the view objects by canonical symbol → view.id
    const match = effectiveSignals.find(
      s => s.canonical?.symbol === sym || s.ticker === sym,
    );
    return match?.id ?? null;
  }, [selectedSignal, effectiveSignals]);

  // Split into longs / shorts sorted by priority (breakout > action > normal) then score
  const longs = useMemo(
    () =>
      filteredSignals
        .filter(s => s.side === 'long')
        .sort((a, b) => signalPriority(b) - signalPriority(a) || compareUpsidePct(a, b)),
    [filteredSignals],
  );

  const shorts = useMemo(
    () =>
      filteredSignals
        .filter(s => s.side === 'short')
        .sort((a, b) => signalPriority(b) - signalPriority(a) || compareUpsidePct(a, b)),
    [filteredSignals],
  );

  const neutrals = useMemo(
    () =>
      filteredSignals
        .filter(s => !s.side && hasForecastRange(s))
        .sort((a, b) => signalPriority(b) - signalPriority(a) || compareUpsidePct(a, b)),
    [filteredSignals],
  );

  const handleRefresh = useCallback(() => {
    if (typeof onRefresh === 'function') onRefresh();
  }, [onRefresh]);

  const uploadSources = useMemo(
    () => buildMacroUploadSources(uploadFreshness),
    [uploadFreshness],
  );
  const uploadAggregateStatus = useMemo(
    () => deriveMacroUploadAggregateStatus(uploadSources),
    [uploadSources],
  );
  const uploadUpdatedAt = useMemo(
    () => deriveMacroUploadUpdatedAt(uploadSources),
    [uploadSources],
  );

  return (
    <Pmv2CardChrome
      as="aside"
      className="macro-signals-card pmv2-card-chrome--with-tabs"
      titleId="macro-signals-title-heading"
      icon={<BarChart2 size={16} />}
      title="Macro Signals"
      actions={(
        <StatusDot
          updatedAt={uploadUpdatedAt}
          status={uploadAggregateStatus}
          size={8}
          label="Macro signal uploads"
          overallLabel="Uploads"
          sources={uploadSources}
          align="right"
        />
      )}
      tabs={(
        <AssetTabs activeAssetClass={selectedAssetClass} onChange={setSelectedAssetClass} />
      )}
      footer={(
        <div className="info-note" role="note">
          <Info className="info-note-icon" aria-hidden />
          <span className="info-note-body">
            Click a security to populate the signal card with Securities Universe data for bet sizing.
          </span>
        </div>
      )}
      bodyClassName="macro-signals-body macro-signals-rows"
    >
      {error && (
        <div className="macro-signals-error">
          <span>⚠ {error}</span>
          <RefreshButton label="Retry" onClick={handleRefresh} loading={loading} />
        </div>
      )}

      {loading && effectiveSignals.length === 0 ? (
        <LoadingIndicator
          label="Loading signals…"
          size="sm"
          centered
          className="macro-signals-empty"
        />
      ) : (
        <>
          {longs.length > 0 && (
            <SignalSection
              variant="long"
              title="LONGS"
              signals={longs}
              activeId={activeId}
              onSelectSignal={onSelectSignal}
            />
          )}
          {shorts.length > 0 && (
            <SignalSection
              variant="short"
              title="SHORTS"
              signals={shorts}
              activeId={activeId}
              onSelectSignal={onSelectSignal}
            />
          )}
          {neutrals.length > 0 && (
            <SignalSection
              variant="neutral"
              title="NEUTRAL"
              signals={neutrals}
              activeId={activeId}
              onSelectSignal={onSelectSignal}
            />
          )}
          {longs.length === 0 && shorts.length === 0 && neutrals.length === 0 && (
            <div className="macro-signals-empty">No signals for this asset class.</div>
          )}
        </>
      )}
    </Pmv2CardChrome>
  );
}

export default MacroSignalsCard;
