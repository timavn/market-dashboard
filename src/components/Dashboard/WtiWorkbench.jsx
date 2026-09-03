import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  BarChart3,
  Droplet,
  RefreshCw,
  ShieldAlert,
  Target,
} from 'lucide-react';
import Pmv2CardChrome from './Pmv2CardChrome';
import predictionMarketsIngestService from '../../services/api/predictionMarketsIngestService';
import { MarketDataService } from '../../services/api/marketDataService';
import { useDashboardResource } from '../../hooks/useDashboardResource';
import { isExplicitLiveInvalidation } from '../../utils/sessionResourceStore';
import { useSurfaceActivity } from '../common/PersistentSurface';
import DelayedDataMarker from './DelayedDataMarker';
import ResourceDataStatusChip from './ResourceDataStatusChip';
import {
  dateKeyInNewYork,
  describeWtiGeometry,
  filterWtiPositionsForEvent,
  findWtiRiskRangeForEvent,
  hasCompleteNativeWtiBook,
  normalizeOvxReference,
  normalizeRecentSettledWtiSessions,
  normalizeSettledWtiSession,
  normalizeWtiCadence,
  normalizeWtiWorkbench,
  selectDefaultWtiMarket,
} from '../../utils/wtiPredictionMarket';
import './PredictionMarkets.css';
import './WtiWorkbench.css';

const WTI_POLL_MS = 30000;
const RECENT_SESSION_LIMIT = 13;

const EMPTY_POSITIONS_STATE = Object.freeze({
  status: 'unavailable',
  positions: [],
  message: 'Verified-live IBKR prediction-market positions are unavailable.',
});

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatMoney(value) {
  const number = finiteNumber(value);
  return number == null ? '—' : `$${number.toFixed(2)}`;
}

function formatCents(value) {
  const number = finiteNumber(value);
  return number == null ? '—' : `${Math.round(number * 100)}¢`;
}

function formatCount(value) {
  const number = finiteNumber(value);
  if (number == null) return '—';
  return new Intl.NumberFormat('en-US', {
    notation: Math.abs(number) >= 1000 ? 'compact' : 'standard',
    maximumFractionDigits: Math.abs(number) >= 1000 ? 1 : 2,
  }).format(number);
}

function formatQuantity(value) {
  const number = finiteNumber(value);
  if (number == null) return '—';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(number);
}

function formatDate(value, { includeTime = false } = {}) {
  if (!value || !Number.isFinite(Date.parse(value))) return '—';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    ...(includeTime ? { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' } : {}),
  }).format(new Date(value));
}

function formatSessionDate(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return '—';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(value));
}

function formatSettlementSource(value) {
  if (!value) return 'Unavailable';
  if (typeof value === 'string') return value;
  return value.name || value.label || value.source || 'Source supplied by venue';
}

function bookPair(bid, ask) {
  return (
    <span className="wti-book-pair">
      <b>{formatCents(bid)}</b><i>/</i><b>{formatCents(ask)}</b>
    </span>
  );
}

function depthPair(bidSize, askSize) {
  return (
    <span className="wti-book-pair">
      <b>{formatCount(bidSize)}</b><i>/</i><b>{formatCount(askSize)}</b>
    </span>
  );
}

function localizedMessage(error, fallback) {
  return error?.response?.data?.error || error?.message || fallback;
}

function LocalizedState({ title, message, loading = false }) {
  return (
    <div className="wti-local-state" role={loading ? 'status' : undefined}>
      {loading ? <RefreshCw size={18} className="wti-spin" aria-hidden="true" /> : <ShieldAlert size={19} aria-hidden="true" />}
      <strong>{title}</strong>
      <span>{message}</span>
    </div>
  );
}

function SessionStrip({ data, sessions }) {
  const rows = useMemo(() => {
    const byTicker = new Map();
    sessions.forEach((session) => {
      if (session?.event?.ticker) byTicker.set(session.event.ticker, session);
    });
    if (data?.historicalOnly && data?.event?.ticker) byTicker.set(data.event.ticker, data);
    const recent = [...byTicker.values()]
      .sort((left, right) => Date.parse(left?.event?.closeTime || 0) - Date.parse(right?.event?.closeTime || 0))
      .slice(-RECENT_SESSION_LIMIT);
    if (!data?.historicalOnly && data?.event?.ticker) recent.push(data);
    return recent;
  }, [data, sessions]);

  if (!rows.length) {
    return (
      <div className="wti-session-strip wti-session-strip--empty">
        <span>Recent verified settlements unavailable</span>
      </div>
    );
  }

  return (
    <div className="wti-session-strip" aria-label="Recent verified WTI settlement sessions">
      {rows.map((session) => {
        const active = session?.event?.ticker === data?.event?.ticker;
        const historical = session?.historicalOnly === true;
        return (
          <article
            key={`${session?.event?.ticker}-${historical ? 'settled' : 'active'}`}
            className={['wti-session-card', active ? 'active' : '', historical ? 'settled' : 'live'].filter(Boolean).join(' ')}
            aria-current={active ? 'date' : undefined}
          >
            <span>{formatSessionDate(session?.event?.closeTime)}</span>
            <strong>{historical ? formatMoney(session.settlementValue) : 'OPEN'}</strong>
            <small>{historical ? 'ICE settlement' : 'research only'}</small>
          </article>
        );
      })}
    </div>
  );
}

function WtiHeader({ cadence, onBack, onCadenceChange, data, sessions, modeMessage, refreshing, onRefresh, resource }) {
  const historical = data?.historicalOnly === true;
  const referenceOnly = data?.referenceOnly === true;
  const mapping = data?.settlementMapping;
  const contractStructure = data?.seriesTicker === 'KXWTI'
    ? 'KXWTI · daily “Above $X” contracts'
    : data?.seriesTicker === 'KXWTIW'
      ? 'KXWTIW · weekly settlement bands'
      : null;
  return (
    <header className="cpi-calculator-header wti-header">
      <div className="wti-header-row">
        <div className="wti-title-block">
          {onBack && (
            <button
              type="button"
              className="wti-back-button"
              onClick={onBack}
              aria-label="Back to prediction markets overview"
            >
              <ArrowLeft size={13} aria-hidden="true" />
              Back
            </button>
          )}
          <span className="wti-title-accent" aria-hidden="true" />
          <Droplet size={19} aria-hidden="true" />
          <div>
            <h1>WTI Prediction Markets</h1>
            <span>{[
              contractStructure,
              historical ? 'Last verified settlement' : 'Direct venue books · research only',
            ].filter(Boolean).join(' · ')}</span>
          </div>
        </div>

        <div className="wti-cadence-switch" aria-label="WTI contract cadence">
          {['daily', 'weekly'].map((option) => (
            <button
              key={option}
              type="button"
              className={cadence === option ? 'active' : ''}
              aria-pressed={cadence === option}
              title={option === 'daily'
                ? 'KXWTI: daily “Above $X” threshold contracts'
                : 'KXWTIW: weekly mutually exclusive settlement bands'}
              onClick={() => onCadenceChange?.(option)}
            >
              {option === 'daily' ? 'Daily' : 'Weekly'}
            </button>
          ))}
        </div>

        <dl className="wti-header-facts">
          <div><dt>Event</dt><dd>{data?.event?.ticker || 'Unavailable'}</dd></div>
          <div><dt>Settlement</dt><dd>{formatDate(data?.event?.observationTime || data?.event?.closeTime, { includeTime: true })}</dd></div>
          <div><dt>ICE contract</dt><dd>{mapping?.contractLabel || mapping?.contractMonth || 'Unverified'}</dd></div>
        </dl>

        <div className="wti-header-actions">
          <ResourceDataStatusChip resource={resource} context="WTI workbench" />
          <span className={`wti-mode-chip ${historical || referenceOnly ? 'historical' : data ? 'live' : 'unavailable'}`}>
            {historical
              ? 'SETTLED · NOT TRADEABLE'
              : referenceOnly
                ? 'REFERENCE GEOMETRY · NO QUOTES'
                : data ? 'DIRECT MARKET · NO EXECUTION' : 'NO VERIFIED CONTRACT'}
          </span>
          <button type="button" onClick={onRefresh} disabled={refreshing} aria-label="Refresh WTI workbench">
            <RefreshCw size={13} className={refreshing ? 'wti-spin' : ''} aria-hidden="true" />
            Refresh
          </button>
        </div>
      </div>
      {modeMessage && <p className="wti-mode-message">{modeMessage}</p>}
      <SessionStrip data={data} sessions={sessions} />
    </header>
  );
}

function ContractsCard({ data, loading, error, selectedTicker, onSelect }) {
  const historical = data?.historicalOnly === true;
  const referenceOnly = data?.referenceOnly === true;
  const markets = data?.markets || [];
  const contractHeading = data?.seriesTicker === 'KXWTI'
    ? 'Above threshold'
    : data?.seriesTicker === 'KXWTIW'
      ? 'Settlement band'
      : 'Contract';
  return (
    <Pmv2CardChrome
      icon={<Target size={14} />}
      title="Contracts"
      titleId="wti-contracts-title"
      className="wti-contracts-card"
      actions={(
        <span className={`wti-card-status ${historical || referenceOnly ? 'historical' : data ? 'live' : 'unavailable'}`}>
          {historical
            ? 'SETTLED OUTCOMES · NO QUOTES'
            : referenceOnly
              ? 'LAST VERIFIED GEOMETRY · NO QUOTES'
              : data ? `${markets.filter(hasCompleteNativeWtiBook).length}/${markets.length} COMPLETE NATIVE BOOKS` : 'UNAVAILABLE'}
        </span>
      )}
    >
      {loading ? (
        <LocalizedState loading title="Checking WTI contracts" message="Loading direct venue books for this cadence." />
      ) : !data ? (
        <LocalizedState title="WTI contracts unavailable" message={error || 'No verified live or settled WTI ladder is available.'} />
      ) : (
        <div className="wti-table-wrap">
          <table aria-label={historical ? `Settled ${data.marketType} WTI outcomes` : `${data.marketType} WTI contract ladder`}>
            <thead>
              {historical ? (
                <tr>
                  <th>{contractHeading}</th><th>Result</th><th>$1 payout</th><th>Volume</th><th>Open interest</th>
                </tr>
              ) : (
                <tr>
                  <th>{contractHeading}</th><th>YES bid / ask</th><th>NO bid / ask</th><th>YES depth</th><th>NO depth</th><th>24h / OI</th><th>Book</th>
                </tr>
              )}
            </thead>
            <tbody>
              {markets.map((market) => {
                const selected = market.ticker === selectedTicker;
                const complete = hasCompleteNativeWtiBook(market);
                return (
                  <tr
                    key={market.ticker}
                    className={selected ? 'selected' : ''}
                    aria-selected={selected}
                    onClick={() => onSelect(market.ticker)}
                  >
                    <td>
                      <button type="button" onClick={() => onSelect(market.ticker)} aria-label={`Inspect ${describeWtiGeometry(market)}`}>
                        <strong>{describeWtiGeometry(market)}</strong>
                        <span>{market.ticker}</span>
                      </button>
                    </td>
                    {historical ? (
                      <>
                        <td><span className={`wti-result ${market.result || 'unknown'}`}>{String(market.result || '—').toUpperCase()}</span></td>
                        <td>{formatMoney(market.settlementPayout)}</td>
                        <td>{formatCount(market.volumeTotal)}</td>
                        <td>{formatCount(market.openInterest)}</td>
                      </>
                    ) : (
                      <>
                        <td>{bookPair(market.yesBid, market.yesAsk)}</td>
                        <td>{bookPair(market.noBid, market.noAsk)}</td>
                        <td>{depthPair(market.yesBidSize, market.yesAskSize)}</td>
                        <td>{depthPair(market.noBidSize, market.noAskSize)}</td>
                        <td><span className="wti-volume-pair"><strong>{formatCount(market.volume24h)}</strong><small>{formatCount(market.openInterest)}</small></span></td>
                        <td><span className={`wti-book-status ${complete ? 'complete' : 'incomplete'}`}>{complete ? 'NATIVE' : 'INCOMPLETE'}</span></td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Pmv2CardChrome>
  );
}

function MappingDetails({ data }) {
  const mapping = data?.settlementMapping || {};
  const available = mapping.status !== 'unavailable';
  return (
    <section className="wti-detail-section" aria-label="WTI settlement mapping">
      <div className="wti-section-heading">
        <span>Settlement mapping</span>
        <strong className={available ? 'available' : 'unavailable'}>{available ? String(mapping.status).toUpperCase() : 'UNAVAILABLE'}</strong>
      </div>
      <dl className="wti-fact-grid">
        <div><dt>ICE contract</dt><dd>{mapping.contractLabel || mapping.contractMonth || '—'}</dd></div>
        <div><dt>Observation</dt><dd>{mapping.observation || '—'}</dd></div>
        <div><dt>Unit / precision</dt><dd>{mapping.unit || '—'}{mapping.precision != null ? ` · ${mapping.precision}` : ''}</dd></div>
        <div><dt>Roll convention</dt><dd>{mapping.rollConvention || '—'}</dd></div>
        <div><dt>Settlement source</dt><dd>{formatSettlementSource(data?.event?.settlementSource)}</dd></div>
        <div><dt>Exact futures marker</dt><dd>Unavailable · no WTI/CL equity substitute</dd></div>
      </dl>
      {!mapping.proxyCalibrationAvailable && (
        <p className="wti-inline-warning">WTIC and OVX remain labeled context only; exact futures-proxy calibration is not verified.</p>
      )}
      {!available && mapping.reason && <p className="wti-inline-warning">{mapping.reason}</p>}
    </section>
  );
}

function PayoutDetails({ data, selectedMarket }) {
  const historical = data?.historicalOnly === true;
  if (!selectedMarket) {
    return <LocalizedState title="Select a contract" message="Choose a WTI contract to inspect deterministic settlement arithmetic." />;
  }
  if (historical) {
    return (
      <section className="wti-detail-section" aria-label="Settled WTI contract result">
        <div className="wti-selection"><span>Selected settled contract</span><strong>{describeWtiGeometry(selectedMarket)}</strong></div>
        <dl className="wti-payout-summary">
          <div><dt>ICE settlement</dt><dd>{formatMoney(data.settlementValue)}</dd></div>
          <div><dt>Result</dt><dd>{String(selectedMarket.result || '—').toUpperCase()}</dd></div>
          <div><dt>$1 YES payout</dt><dd>{formatMoney(selectedMarket.settlementPayout)}</dd></div>
        </dl>
        <p className="wti-research-note">Historical outcome only. Live bids, asks, depth, recommendations, and execution are intentionally absent.</p>
      </section>
    );
  }

  const derivedFields = new Set(selectedMarket.nativeBook?.derivedFields || []);
  const directAsk = (side) => {
    const key = `${side.toLowerCase()}Ask`;
    const sidePrices = selectedMarket.nativeBook?.[`${side.toLowerCase()}Prices`];
    const ask = finiteNumber(selectedMarket[key]);
    return ask != null && ask >= 0 && ask <= 1 && sidePrices !== false && !derivedFields.has(key)
      ? ask
      : null;
  };
  const rows = [
    { side: 'YES', ask: directAsk('yes') },
    { side: 'NO', ask: directAsk('no') },
  ];
  const everySideHasDirectAsk = rows.every((row) => row.ask != null);
  return (
    <section className="wti-detail-section" aria-label="Selected WTI contract payout arithmetic">
      <div className="wti-selection"><span>Selected contract</span><strong>{describeWtiGeometry(selectedMarket)}</strong></div>
      <div className="wti-payout-table-wrap">
        <table className="wti-payout-table" aria-label="Selected WTI contract payout arithmetic">
          <thead><tr><th>Side</th><th>Native ask</th><th>Cost</th><th>Payout if wins</th><th>Max gross gain</th><th>Max gross loss</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.side}>
                <th><span className={`wti-side ${row.side.toLowerCase()}`}>{row.side}</span></th>
                <td>{formatCents(row.ask)}</td>
                <td>{formatMoney(row.ask)}</td>
                <td>{row.ask == null ? '—' : '$1.00'}</td>
                <td className="positive">{row.ask == null ? '—' : formatMoney(1 - row.ask)}</td>
                <td className="negative">{row.ask == null ? '—' : formatMoney(-row.ask)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!everySideHasDirectAsk && <p className="wti-inline-warning">Only sides with a verified direct native ask show cost and gross payout arithmetic; unavailable sides remain blank.</p>}
      <p className="wti-research-note">Per contract, before fees. Native market prices only—no fair odds, model edge, sizing, recommendation, or order entry.</p>
    </section>
  );
}

function ContextDetails({ data, riskRangeState, ovxState }) {
  const riskRange = riskRangeState.value;
  const ovx = ovxState.value;
  return (
    <section className="wti-context-grid" aria-label="WTI reference context">
      <div className="wti-context-card">
        <div className="wti-section-heading"><span>WTIC Risk Range</span><strong className={riskRange ? 'available' : 'unavailable'}>{riskRange ? riskRange.date : 'UNAVAILABLE'}</strong></div>
        {riskRange ? (
          <dl><div><dt>LRR</dt><dd>{formatMoney(riskRange.lrr)}</dd></div><div><dt>HRR</dt><dd>{formatMoney(riskRange.hrr)}</dd></div><div><dt>Trend</dt><dd>{riskRange.trend || '—'}</dd></div></dl>
        ) : <p>{riskRangeState.message}</p>}
        <small>Exact event-date Hedgeye reference only. It is not a market quote or probability.</small>
      </div>
      <div className="wti-context-card">
        <div className="wti-section-heading">
          <span>OVX context</span>
          {!ovx || !ovx.refreshDelayed ? (
            <strong className={ovx ? 'available' : 'unavailable'}>{ovx ? 'CURRENT' : 'UNAVAILABLE'}</strong>
          ) : null}
        </div>
        {ovx ? (
          <dl><div><dt>OVX</dt><dd>{ovx.value.toFixed(2)}<DelayedDataMarker status={ovx.refreshDelayed ? 'refresh-delayed' : 'live'} title={`Refresh delayed · last verified ${ovx.lastVerifiedAt || ovx.asOf || 'time unavailable'}`} updatedAt={ovx.lastVerifiedAt || ovx.asOf} /></dd></div><div><dt>As of</dt><dd>{formatDate(ovx.asOf, { includeTime: true })}</dd></div><div><dt>Source</dt><dd>{ovx.source || '—'}{ovx.quoteMode ? ` · ${ovx.quoteMode}` : ''}{ovx.refreshDelayed ? ' · last verified' : ''}</dd></div></dl>
        ) : <p>{ovxState.message}</p>}
        <small>Volatility regime reference only; never used as an executable price or automatic signal.</small>
      </div>
    </section>
  );
}

function PositionDetails({ sharedPositionsState, eventTicker }) {
  const state = sharedPositionsState || EMPTY_POSITIONS_STATE;
  const positions = filterWtiPositionsForEvent(state, eventTicker);
  const status = String(state.status || 'unavailable').toLowerCase();
  return (
    <section className="wti-detail-section wti-position-section" aria-label="Matching verified IBKR WTI positions">
      <div className="wti-section-heading">
        <span>IBKR exact-event positions</span>
        <strong className={['live', 'partial'].includes(status) ? 'available' : 'unavailable'}>{status.toUpperCase()}</strong>
      </div>
      {status === 'loading' ? (
        <p>Checking verified-live IBKR positions.</p>
      ) : !['live', 'partial'].includes(status) ? (
        <p>{state.message || 'Verified-live IBKR positions are unavailable.'}</p>
      ) : positions.length === 0 ? (
        <p>No open positions match {eventTicker || 'this WTI event'}.</p>
      ) : (
        <div className="wti-position-table-wrap">
          <table>
            <thead><tr><th>Account</th><th>Contract</th><th>Quantity</th><th>Average cost</th><th>Cost basis</th></tr></thead>
            <tbody>
              {positions.map((position, index) => (
                <tr key={position.conid || `${position.accountId}-${position.localSymbol || position.symbol}-${index}`}>
                  <td>{position.accountId || position.account || '—'}</td>
                  <td>{position.localSymbol || position.description || position.symbol || '—'}</td>
                  <td>{formatQuantity(position.quantity ?? position.position)}</td>
                  <td>{formatMoney(position.avgCost ?? position.averageCost)}</td>
                  <td>{formatMoney(position.costBasis)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {status === 'partial' && <p className="wti-inline-warning">Some accounts are unavailable; only positions from successfully synchronized accounts are shown.</p>}
    </section>
  );
}

function DetailsCard({ data, loading, error, selectedMarket, riskRangeState, ovxState, sharedPositionsState }) {
  return (
    <Pmv2CardChrome
      icon={<BarChart3 size={14} />}
      title="Exposure & settlement details"
      titleId="wti-details-title"
      className="wti-details-card"
      actions={<span className="wti-card-status">$1 PAYOUT · BEFORE FEES · RESEARCH ONLY</span>}
    >
      {loading ? (
        <LocalizedState loading title="Loading WTI details" message="Settlement mapping and reference context are being checked independently." />
      ) : !data ? (
        <LocalizedState title="WTI details unavailable" message={error || 'No verified WTI session is available for this cadence.'} />
      ) : (
        <div className="wti-details-scroll">
          <PayoutDetails data={data} selectedMarket={selectedMarket} />
          <MappingDetails data={data} />
          <ContextDetails data={data} riskRangeState={riskRangeState} ovxState={ovxState} />
          <PositionDetails sharedPositionsState={sharedPositionsState} eventTicker={data.event?.ticker} />
          <section className="wti-detail-section" aria-label="WTI settlement rules">
            <div className="wti-section-heading"><span>Venue rules</span><strong>AUTHORITATIVE TEXT</strong></div>
            <p>{selectedMarket?.rulesPrimary || 'Primary settlement rule unavailable.'}</p>
            {selectedMarket?.rulesSecondary && <p>{selectedMarket.rulesSecondary}</p>}
          </section>
        </div>
      )}
    </Pmv2CardChrome>
  );
}

function settledPayloadFromSession(session) {
  if (!session || typeof session !== 'object') return null;
  return {
    historicalOnly: true,
    executable: false,
    ...session,
  };
}

export default function WtiWorkbench({
  cadence = 'daily',
  onBack,
  onCadenceChange,
  sharedPositionsState = EMPTY_POSITIONS_STATE,
}) {
  const active = useSurfaceActivity();
  const normalizedCadence = normalizeWtiCadence(cadence);
  const [selectedTickers, setSelectedTickers] = useState({});
  const safeAuxByCadenceRef = useRef(new Map());
  const loadWorkbench = useCallback(async () => {
    const capture = (promise) => promise
      .then((value) => ({ value, error: null }))
      .catch((loadError) => ({ value: null, error: loadError }));
    const [liveResult, settledResult, recentResult, historyResult, volatilityResult] = await Promise.all([
      capture(predictionMarketsIngestService.getWtiWorkbench(normalizedCadence)),
      capture(predictionMarketsIngestService.getLastSettledWtiSession(normalizedCadence)),
      capture(predictionMarketsIngestService.getRecentSettledWtiSessions(normalizedCadence, RECENT_SESSION_LIMIT)),
      capture(MarketDataService.getRiskRangeHistory('WTIC', 45)),
      capture(MarketDataService.getVolatilitySnapshot()),
    ]);

    const live = normalizeWtiWorkbench(liveResult.value, normalizedCadence);
    const settled = normalizeSettledWtiSession(settledPayloadFromSession(settledResult.value), normalizedCadence);
    const nextData = live.ok ? live.data : settled;
    if (!nextData) {
      const refreshError = liveResult.error || settledResult.error;
      const failure = refreshError instanceof Error
        ? refreshError
        : new Error(localizedMessage(
        refreshError,
        live.reason === 'no_direct_native_book'
          ? 'No direct native WTI prices are available, and no verified settled session could be loaded.'
          : 'No verified live or settled WTI session is available for this cadence.',
        ));
      if (isExplicitLiveInvalidation(refreshError)) failure.liveInvalidation = true;
      throw failure;
    }

    const previousAux = safeAuxByCadenceRef.current.get(normalizedCadence) || {};
    const sessions = recentResult.error
      ? previousAux.sessions || []
      : normalizeRecentSettledWtiSessions(recentResult.value, normalizedCadence);
    const inlineRiskRange = findWtiRiskRangeForEvent([nextData.riskRange], nextData.event);
    const exactRiskRange = inlineRiskRange || findWtiRiskRangeForEvent(historyResult.value, nextData.event);
    const eventDate = dateKeyInNewYork(nextData.event?.strikeDate || nextData.event?.closeTime);
    const retainedRiskRange = historyResult.error && previousAux.riskRange?.date === eventDate
      ? previousAux.riskRange
      : null;
    const riskRange = exactRiskRange || retainedRiskRange;
    const normalizedOvx = normalizeOvxReference(volatilityResult.value, {
      historical: nextData.historicalOnly,
    });
    const retainedOvx = !nextData.historicalOnly && volatilityResult.error && previousAux.ovxReference
      ? {
          ...previousAux.ovxReference,
          status: 'refresh-delayed',
          availability: 'reference',
          refreshDelayed: true,
          lastVerifiedAt: previousAux.ovxReference.asOf,
        }
      : null;
    const ovxReference = ['available', 'refresh-delayed'].includes(normalizedOvx.status)
      ? normalizedOvx
      : retainedOvx;
    const snapshot = {
      ...nextData,
      cadence: normalizedCadence,
      sessions,
      riskRange,
      riskRangeMessage: riskRange
        ? null
        : historyResult.error
          ? localizedMessage(historyResult.error, 'WTIC Risk Range refresh is delayed.')
          : `No date-matched WTIC Risk Range is available for ${eventDate || 'this event'}.`,
      ovxReference,
      ovxMessage: ovxReference
        ? null
        : nextData.historicalOnly
          ? 'Historical OVX snapshots are not available.'
          : volatilityResult.error
            ? localizedMessage(volatilityResult.error, 'OVX reference is unavailable.')
            : normalizedOvx.reason,
      modeMessage: live.ok
      ? null
        : `Live ${normalizedCadence} books are unavailable. Showing the most recent fully verified settlement; no live quotes are displayed.`,
      resourceObservedAt: new Date(Date.now()).toISOString(),
    };
    safeAuxByCadenceRef.current.set(normalizedCadence, {
      sessions,
      riskRange,
      ovxReference,
    });
    return snapshot;
  }, [normalizedCadence]);
  const resource = useDashboardResource('wti-workbench', { cadence: normalizedCadence }, {
    fetcher: loadWorkbench,
    validate: (value) => (
      value
      && typeof value === 'object'
      && value.cadence === normalizedCadence
      && Array.isArray(value.markets)
      && value.resourceObservedAt
        ? value
        : null
    ),
    getObservedAt: (value) => value.resourceObservedAt,
    maxAgeMs: Math.max(WTI_POLL_MS + 15_000, 45_000),
    pollIntervalMs: WTI_POLL_MS,
    active,
    refreshOnActivate: false,
    invalidateOnScopeChange: true,
    isExplicitInvalidation: isExplicitLiveInvalidation,
  });
  const data = resource.data || resource.referenceData;
  const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
  const riskRangeState = {
    value: data?.riskRange || null,
    message: data?.riskRangeMessage || 'Checking exact-date WTIC Risk Range.',
  };
  const ovxState = {
    value: data?.ovxReference || null,
    message: data?.ovxMessage || 'Checking current-session OVX context.',
  };
  const modeMessage = data?.modeMessage || (
    resource.error && data
      ? 'WTI refresh delayed. Showing the last validated non-executable reference.'
      : null
  );
  const error = resource.error
    ? localizedMessage(resource.error, 'WTI workbench is unavailable.')
    : null;
  const loading = resource.initialLoading && !data;
  const refreshing = resource.refreshing;
  const selectedTicker = selectedTickers[normalizedCadence] || null;

  useEffect(() => {
    if (!data?.markets?.length) return;
    if (data.markets.some((market) => market.ticker === selectedTicker)) return;
    const fallback = selectDefaultWtiMarket(data.markets)?.ticker || null;
    setSelectedTickers((current) => ({ ...current, [normalizedCadence]: fallback }));
  }, [data, normalizedCadence, selectedTicker]);

  const selectedMarket = useMemo(
    () => data?.markets?.find((market) => market.ticker === selectedTicker) || data?.markets?.[0] || null,
    [data, selectedTicker],
  );

  return (
    <section className="wti-workbench cpi-workbench-shell" aria-label="WTI prediction-market workbench">
      <WtiHeader
        cadence={normalizedCadence}
        onBack={onBack}
        onCadenceChange={onCadenceChange}
        data={data}
        sessions={sessions}
        modeMessage={modeMessage}
        refreshing={refreshing}
        onRefresh={resource.refresh}
        resource={resource}
      />
      <div className="wti-workbench-grid">
        <ContractsCard
          data={data}
          loading={loading}
          error={error}
          selectedTicker={selectedMarket?.ticker}
          onSelect={(ticker) => setSelectedTickers((current) => ({
            ...current,
            [normalizedCadence]: ticker,
          }))}
        />
        <DetailsCard
          data={data}
          loading={loading}
          error={error}
          selectedMarket={selectedMarket}
          riskRangeState={riskRangeState}
          ovxState={ovxState}
          sharedPositionsState={sharedPositionsState}
        />
      </div>
    </section>
  );
}
