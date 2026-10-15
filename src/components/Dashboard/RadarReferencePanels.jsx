import usePageScrollLock from '../../hooks/usePageScrollLock';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MarketDataService } from '../../services/api/marketDataService';
import CFTCNetLongCard, { getCftcFreshness } from './CFTCNetLongCard';
import DelayedDataMarker from './DelayedDataMarker';
import { delayedMarkerMarketContext } from '../../utils/delayedMarkerMarketContext';
import DollarLiquidityModels from './DollarLiquidityModels';
import GlobalQuadsCard, { QuadsPreview } from './GlobalQuadsCard';
import { useGlobalQuads } from '../../hooks/useGlobalQuads';
import MarketSituationReportCard, {
  getMarketSituationFreshness,
} from './MarketSituationReportCard';
import MarketVolumeTable, { getVolumeCardHeaderDate } from './MarketVolumeTable';
import PersistentSurface from '../common/PersistentSurface';
import { useDashboardResource } from '../../hooks/useDashboardResource';
import { useMarketStructureReport } from '../../hooks/useMarketStructureReport';
import { isRetainedQuoteReference, isVerifiedProviderRow } from '../../utils/marketQuoteReference.cjs';
import { getCftcHighlightRows, getCftcReportDate } from '../../utils/cftcHighlights';
import {
  cftcValueClass,
  formatCftcDate,
  formatCftcRetrieval,
  isCftcResearchSnapshot,
} from '../../utils/cftcPositioningPresentation';

const ANALYTICS_REFRESH_MS = 15 * 60 * 1000;
const IBKR_LIVE_DISPLAY_MAX_AGE_MS = 2 * 60 * 1000;
const CONTINUOUS_CRYPTO_SYMBOLS = new Set(['BTC', 'ETH', 'BNB', 'ADA', 'SOL', 'XRP']);

const PANEL_TITLES = {
  cftc: 'CFTC Positioning',
  situation: 'Market Situation',
  quads: 'Global Quads',
  liquidity: 'Dollar Liquidity',
  volume: 'Volume',
};

const requireReferenceObject = (payload) => {
  if (!payload || typeof payload !== 'object') {
    throw new Error('The dated reference response was unavailable.');
  }
  return payload;
};

const readManualRecord = (key) => {
  if (typeof window === 'undefined') return { rows: {}, lastEditedAt: null };
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { rows: {}, lastEditedAt: null };
    }
    const { lastEditedAt = null, _meta, ...rows } = parsed;
    return {
      rows: rows?.data && typeof rows.data === 'object' ? rows.data : rows,
      lastEditedAt:
        lastEditedAt ||
        _meta?.lastEditedAt ||
        window.localStorage.getItem(`${key}.lastEditedAt`) ||
        null,
    };
  } catch {
    return { rows: {}, lastEditedAt: null };
  }
};

const isFiniteNumber = (value) => value !== '' && value != null && Number.isFinite(Number(value));

const formatDate = (value, options = { month: 'short', day: 'numeric' }) => {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleDateString('en-US', { ...options, timeZone: 'UTC' }).toUpperCase();
};

const formatNumber = (value, digits = 2) => {
  if (!isFiniteNumber(value)) return '—';
  return Number(value).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
};

const formatSigned = (value, suffix = '') => {
  if (!isFiniteNumber(value)) return '—';
  const numeric = Number(value);
  return `${numeric > 0 ? '+' : ''}${numeric.toFixed(2)}${suffix}`;
};

const getRowQuoteStatus = (row, providerStatus, { allowReference = false } = {}) => {
  if (allowReference && isRetainedQuoteReference(row)) return 'refresh-delayed';
  if (allowReference && !isVerifiedProviderRow(row)) return 'unavailable';
  if (!row || !['current', 'delayed', 'historical'].includes(row.availability)) return 'unavailable';
  const source = String(row.source || row.provider || '').toLowerCase();
  const quoteMode = String(row.dataType || row.quoteMode || row.freshness || '').toLowerCase();
  const quoteAsOf = row.quoteAsOf || row.timestamp || row.asOf;
  const quoteDate = quoteAsOf ? new Date(quoteAsOf) : null;
  const providerExplicitlyOffline = Boolean(
    providerStatus
      && (
        providerStatus?.ibkr?.connected === false
        || /offline|disconnected/i.test(String(providerStatus?.ibkr?.status || providerStatus?.status || ''))
      )
  );

  if (!quoteDate || Number.isNaN(quoteDate.getTime())) return 'unavailable';
  const quoteAge = Date.now() - quoteDate.getTime();
  if (quoteAge < -5 * 60 * 1000) return 'unavailable';
  if (/(?:mock|seed|seeded|synthetic|inferred|portfolio-derived)/i.test([
    source,
    quoteMode,
    row.warning,
    row.error,
  ].filter(Boolean).join(' '))) return 'unavailable';
  if (row.freshness && row.freshness !== 'current') return 'unavailable';
  if (row.sourceStatus && row.sourceStatus !== 'current') return 'unavailable';
  const warning = String(row.warning || '');
  // Auto-routed analytical rows deliberately preserve the rejected IBKR
  // attempt in the warning when a separately timestamped Yahoo quote wins.
  // Direct Yahoo rows also carry `yahoo_fallback` as provenance. Both are
  // valid delayed observations; only an unapproved warning (for example a
  // stale/cache/offline marker) should invalidate the row.
  const yahooProvenanceWarning = source.includes('yahoo')
    && (
      /^ibkr\s*:/i.test(warning)
      || warning.split(';').map((part) => part.trim()).filter(Boolean).every((part) => (
        /^(?:ibkr_unavailable|yahoo_fallback|delayed_data)$/i.test(part)
      ))
    );
  if (/stale|offline|cache|mock|seed|synthetic|fallback|inferred|portfolio/i.test(
    [
      quoteMode,
      yahooProvenanceWarning ? null : warning,
      row.error,
      row.entitlementStatus,
    ].filter(Boolean).join(' ')
  )) {
    return 'unavailable';
  }
  const datedStatus = allowReference && isVerifiedProviderRow(row) ? 'refresh-delayed' : 'unavailable';
  if (source.includes('ibkr') && providerExplicitlyOffline) return datedStatus;
  if (row.availability === 'delayed' && quoteMode === 'delayed') {
    const symbol = String(row.symbol || row.ticker || '').toUpperCase();
    const maxAge = CONTINUOUS_CRYPTO_SYMBOLS.has(symbol)
      ? 2 * 60 * 60 * 1000
      : 4 * 24 * 60 * 60 * 1000;
    return quoteAge <= maxAge ? 'delayed' : datedStatus;
  }
  if (row.availability === 'historical' || quoteMode.includes('historical') || source.includes('fred')) return 'historical';
  if (
    row.availability === 'current' &&
    source.includes('ibkr') &&
    ['live', 'unknown'].includes(quoteMode)
  ) return quoteAge <= IBKR_LIVE_DISPLAY_MAX_AGE_MS ? 'live' : datedStatus;
  return 'unavailable';
};

const aggregateQuoteStatus = (rows, providerStatus, options) => {
  const statuses = (Array.isArray(rows) ? rows : []).map((row) => getRowQuoteStatus(row, providerStatus, options));
  const eligible = statuses.filter((status) => status !== 'unavailable');
  if (eligible.length === 0) return 'unavailable';
  if (eligible.length !== statuses.length) return 'mixed';
  if (new Set(eligible).size > 1) return 'mixed';
  if (eligible.includes('refresh-delayed')) return 'refresh-delayed';
  if (eligible.includes('delayed')) return 'delayed';
  if (eligible.includes('historical')) return 'historical';
  return 'live';
};

const PreviewCard = ({
  id,
  title,
  status,
  headerNote,
  onOpen,
  children,
}) => (
  <section
    className={`efr-reference-card efr-reference-card--${id}`}
    aria-labelledby={`efr-reference-${id}`}
    data-status={status}
  >
    <header className={`efr-reference-card__header${headerNote ? ' efr-reference-card__header--dated' : ''}`}>
      <button
        type="button"
        className="efr-reference-card__title"
        onClick={() => onOpen(id)}
        id={`efr-reference-${id}`}
        aria-haspopup="dialog"
      >
        {title}
      </button>
      {headerNote && <span className="efr-reference-card__header-note">{headerNote}</span>}
    </header>
    <div className="efr-reference-card__body">{children}</div>
  </section>
);

const EmptyPreview = ({ children = 'No verified data available' }) => (
  <div className="efr-reference-empty">{children}</div>
);

const CurrenciesPreview = ({
  rows,
  providerStatus,
  ariaLabel = 'Currencies',
  maxRows = 5,
}) => {
  const displayRows = (Array.isArray(rows) ? rows : []).slice(0, maxRows);
  if (displayRows.length === 0) return <EmptyPreview />;

  return (
    <table className="efr-mini-table" aria-label={ariaLabel}>
      <thead>
        <tr><th>Ticker</th><th>Price</th><th>Day</th><th>30D As of</th></tr>
      </thead>
      <tbody>
        {displayRows.map((row) => {
          const status = getRowQuoteStatus(row, providerStatus);
          const available = status !== 'unavailable';
          const quoteAsOf = row?.lastVerifiedAt || row?.quoteAsOf || row?.timestamp || row?.asOf;
          const delayedTitle = row?.displayDelayed
            ? `Refresh delayed · last verified ${quoteAsOf || 'time unavailable'}`
            : status === 'historical'
              ? `Historical reference · as of ${quoteAsOf || 'time unavailable'}`
              : `Delayed quote · as of ${quoteAsOf || 'time unavailable'}`;
          return (
            <tr key={row.symbol || row.name}>
              <td>{row.name || row.symbol}</td>
              <td>
                {available ? (
                  <span className="efr-backdrop-price">
                    <span>{formatNumber(row.price, Number(row.price) < 10 ? 3 : 2)}</span>
                    <DelayedDataMarker status={status} title={delayedTitle} updatedAt={quoteAsOf}
                      {...delayedMarkerMarketContext(row)} />
                  </span>
                ) : '—'}
              </td>
              <td className={available && Number(row.changePercent) !== 0 ? (Number(row.changePercent) > 0 ? 'is-positive' : 'is-negative') : ''}>
                {available ? formatSigned(row.changePercent, '%') : '—'}
              </td>
              <td title={row.periodReturnsAsOf ? `Period return as of ${row.periodReturnsAsOf}` : undefined}>
                {available && row.periodReturnsStatus !== 'unavailable' ? formatSigned(row.thirtyDayChangePct, '%') : '—'}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
};

const CftcPreview = ({ data, refreshFailed = false }) => {
  const rows = getCftcHighlightRows(data);
  if (rows.length === 0) return <EmptyPreview>UNAVAILABLE</EmptyPreview>;
  const reportDate = getCftcReportDate(data);
  const freshness = getCftcFreshness(reportDate, {
    refreshFailed,
    cacheState: data?.cacheState,
    sourceVerified: true,
    decisionEligible: data?.decisionEligible === true,
    contentComplete: data?.contentComplete === true,
  });
  const reportTitle = `Official CFTC · ${freshness.label} · Largest absolute 1Y Z-scores first`;
  return (
    <table className="efr-mini-table cftc-preview-grid" aria-label="CFTC positioning preview" title={reportTitle}>
      <thead><tr><th>Asset</th><th>Net position</th><th>W/W</th><th>
        1Y Z-score <DelayedDataMarker status={freshness.referenceOnly ? 'reference' : 'historical'} title={reportTitle}
          updatedAt={reportDate} marketSessionDate={reportDate} />
      </th></tr></thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={`${row.metric || 'position'}-${index}`}>
            <td>{row.metric || '—'}</td>
            <td className={cftcValueClass(isFiniteNumber(row.latest) ? Number(row.latest) : null)}>{isFiniteNumber(row.latest) ? Number(row.latest).toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—'}</td>
            <td className={cftcValueClass(isFiniteNumber(row.wwChg) ? Number(row.wwChg) : null)}>
              {isFiniteNumber(row.wwChg) ? `${Number(row.wwChg) > 0 ? '+' : ''}${Number(row.wwChg).toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '—'}
            </td>
            <td className={cftcValueClass(isFiniteNumber(row.zScore1Y) ? Number(row.zScore1Y) : null, { score: true })}>
              {formatNumber(row.zScore1Y, 2)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

const LiquidityPreview = ({ data }) => {
  const global = data?.models?.global?.latest;
  const us = data?.models?.us?.latest;
  if (!global && !us) return <EmptyPreview />;
  const rows = [
    ['Global risk score', global?.riskScore, (value) => `${formatNumber(value, 1)}/100`],
    ['Global M2 / GDP', global?.m2ToGdp, (value) => formatNumber(value, 3)],
    ['U.S. stack / GDP', us?.stackToGdp, (value) => formatNumber(value, 3)],
    ['Global regime', global?.regime, (value) => value || '—'],
    ['U.S. regime', us?.regime, (value) => value || '—'],
    ['U.S. liquidity growth · 3M', us?.growth?.['3m'], (value) => isFiniteNumber(value) ? formatSigned(Number(value) * 100, '%') : '—'],
  ];
  return (
    <table className="efr-mini-table">
      <thead><tr><th>Metric</th><th>Value</th></tr></thead>
      <tbody>{rows.map(([label, value, formatter]) => <tr key={label}><td>{label}</td><td>{formatter(value)}</td></tr>)}</tbody>
    </table>
  );
};

const FullReferencePanel = ({
  activePanel,
  onClose,
  cftcState,
  marketSituationState,
  liquidityState,
  quadsResource,
  volumeTitle,
}) => {
  const dialogRef = useRef(null);
  const titleButtonRef = useRef(null);
  const [lastPanel, setLastPanel] = useState(activePanel);

  useEffect(() => {
    if (activePanel) setLastPanel(activePanel);
  }, [activePanel]);

  usePageScrollLock(Boolean(activePanel));

  useEffect(() => {
    if (!activePanel) return undefined;
    const frame = requestAnimationFrame(() => titleButtonRef.current?.focus());
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )).filter((element) => element.getClientRects().length > 0);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [activePanel, onClose]);

  return (
    <PersistentSurface
      active={Boolean(activePanel)}
      className={`efr-reference-overlay${(activePanel || lastPanel) === 'quads' ? ' efr-reference-overlay--quads' : ''}${(activePanel || lastPanel) === 'cftc' ? ' efr-reference-overlay--cftc' : ''}`}
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section ref={dialogRef} className={`dashboard-table-dialog efr-reference-dialog${(activePanel || lastPanel) === 'quads' ? ' efr-reference-dialog--quads' : ''}${(activePanel || lastPanel) === 'volume' ? ' efr-reference-dialog--volume' : ''}${(activePanel || lastPanel) === 'cftc' ? ' efr-reference-dialog--cftc' : ''}`} role="dialog" aria-modal="true" aria-labelledby="efr-reference-dialog-title">
        <header className="efr-reference-dialog__header dashboard-table-dialog__header">
          <h2 id="efr-reference-dialog-title">
            <button
              ref={titleButtonRef}
              className="dashboard-table-dialog__title"
              type="button"
              onClick={onClose}
              title={`Close ${PANEL_TITLES[activePanel || lastPanel] || 'reference panel'}`}
            >
              {(activePanel || lastPanel) === 'volume' ? volumeTitle : PANEL_TITLES[activePanel || lastPanel]}
            </button>
          </h2>
        </header>
        <div className="efr-reference-dialog__body">
          <PersistentSurface active={activePanel === 'cftc'}>
            <CFTCNetLongCard resourceState={cftcState} />
          </PersistentSurface>
          <PersistentSurface active={activePanel === 'situation'}>
            <MarketSituationReportCard
              snapshot={marketSituationState.data}
              loading={marketSituationState.loading}
              refreshing={marketSituationState.refreshing}
              error={marketSituationState.error}
            />
          </PersistentSurface>
          <PersistentSurface active={activePanel === 'quads'}>
            <GlobalQuadsCard resourceState={quadsResource} />
          </PersistentSurface>
          <PersistentSurface active={activePanel === 'liquidity'}>
            <DollarLiquidityModels resourceState={liquidityState} />
          </PersistentSurface>
          <PersistentSurface active={activePanel === 'volume'}>
            <MarketVolumeTable showDetails showAsOf={false} />
          </PersistentSurface>
        </div>
      </section>
    </PersistentSurface>
  );
};

const RadarReferencePanels = ({ onDashboardStatusChange }) => {
  const [activePanel, setActivePanel] = useState(null);
  const [volumeMeta, setVolumeMeta] = useState({ sources: [], asOf: null, datasetStatus: null });
  const volumeTitle = <>Volume{volumeMeta.asOf ? (
    <> <time dateTime={volumeMeta.asOf}>({getVolumeCardHeaderDate({ asOf: volumeMeta.asOf })})</time></>
  ) : null}</>;
  const quadsResource = useGlobalQuads();
  const lastTriggerRef = useRef(null);
  const loadCftc = useCallback(async () => {
    const backendUrl = process.env.REACT_APP_BACKEND_URL || 'http://localhost:3001';
    const response = await fetch(`${backendUrl}/api/hedgeye/snapshot/cftc-positioning`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error || `CFTC request failed (${response.status})`);
    return payload;
  }, []);
  const loadLiquidity = useCallback(
    () => MarketDataService.getDollarLiquidityModels(),
    [],
  );
  const cftcResource = useDashboardResource('cftc', {}, {
    fetcher: loadCftc,
    validate: requireReferenceObject,
    getObservedAt: getCftcReportDate,
    pollIntervalMs: ANALYTICS_REFRESH_MS,
    active: true,
  });
  const situationResource = useMarketStructureReport({ active: true });
  const liquidityResource = useDashboardResource('dollar-liquidity', {}, {
    fetcher: loadLiquidity,
    validate: requireReferenceObject,
    getObservedAt: (payload) => (
      payload?.models?.us?.latest?.date || payload?.models?.global?.latest?.date || null
    ),
    pollIntervalMs: ANALYTICS_REFRESH_MS,
    active: true,
  });
  const cftcState = {
    data: cftcResource.data,
    loading: cftcResource.initialLoading && !cftcResource.data,
    refreshing: cftcResource.refreshing,
    error: cftcResource.error?.message || null,
  };
  const marketSituationState = {
    data: situationResource.data,
    loading: situationResource.initialLoading && !situationResource.data,
    refreshing: situationResource.refreshing,
    error: situationResource.error?.message || null,
  };
  const liquidityState = {
    data: liquidityResource.data,
    loading: liquidityResource.initialLoading && !liquidityResource.data,
    refreshing: liquidityResource.refreshing,
    error: liquidityResource.error?.message || null,
  };

  const openPanel = useCallback((panelId) => {
    lastTriggerRef.current = document.activeElement;
    setActivePanel(panelId);
  }, []);

  const closePanel = useCallback(() => {
    setActivePanel(null);
    window.requestAnimationFrame(() => lastTriggerRef.current?.focus?.());
  }, []);

  const cftcDate = getCftcReportDate(cftcState.data);
  const cftcHeaderDate = isCftcResearchSnapshot(cftcState.data) ? cftcDate : null;
  const cftcLastChecked = formatCftcRetrieval(cftcState.data?.retrievedAt);
  const marketSituationFreshness = getMarketSituationFreshness(marketSituationState.data);
  const marketSituationDate = marketSituationState.data?.date
    || marketSituationState.data?.publishedAt
    || null;
  const liquidityDate =
    liquidityState.data?.models?.us?.latest?.date ||
    liquidityState.data?.models?.global?.latest?.date ||
    null;
  const cftcAvailable = Array.isArray(cftcState.data?.data) && cftcState.data.data.length > 0;
  const cftcOfficial = cftcState.data?.source === 'cftc-public-reporting-environment';
  const cftcDecisionEligible = cftcState.data?.decisionEligible === true;
  const cftcPartial = cftcOfficial
    && cftcDecisionEligible
    && cftcState.data?.contentComplete !== true;
  const liquidityAvailable = Boolean(
    liquidityState.data?.models?.global?.latest || liquidityState.data?.models?.us?.latest
  );
  const liquidityGlobalModel = liquidityState.data?.models?.global?.latest;
  const liquidityUsModel = liquidityState.data?.models?.us?.latest;
  const cftcAgeMs = cftcDate ? Date.now() - new Date(`${String(cftcDate).slice(0, 10)}T23:59:59Z`).getTime() : Infinity;
  const cftcStale = cftcAvailable && (
    !Number.isFinite(cftcAgeMs)
    || cftcAgeMs > 10 * 24 * 60 * 60 * 1000
    || cftcState.data?.cacheState === 'stale'
  );
  const liquidityPartial = liquidityAvailable && (
    liquidityState.data?.models?.global?.status === 'partial' ||
    liquidityState.data?.models?.us?.status === 'partial' ||
    liquidityState.data?.models?.us?.components?.some?.((component) => component.provisional)
  );
  const volumeStatus = useMemo(() => {
    if (!volumeMeta.sources.length) return 'loading';
    const availableSources = volumeMeta.sources.filter((source) => source.status === 'current');
    if (!availableSources.length) return 'unavailable';
    if (availableSources.length < volumeMeta.sources.length) return 'mixed';
    return 'historical';
  }, [volumeMeta.sources]);
  const handleVolumeSources = useCallback((sources) => {
    setVolumeMeta((current) => ({ ...current, sources: Array.isArray(sources) ? sources : [] }));
  }, []);
  const handleVolumeHeader = useCallback((asOf) => {
    setVolumeMeta((current) => ({ ...current, asOf: asOf ? current.asOf : null }));
  }, []);
  const handleVolumeMetadata = useCallback((metadata) => {
    setVolumeMeta((current) => ({
      ...current,
      asOf: metadata?.asOfTradingDate || null,
      datasetStatus: metadata?.status || null,
    }));
  }, []);
  const volumeSourceIssues = useMemo(() => volumeMeta.sources
    .filter((source) => source?.status !== 'current')
    .map((source) => (
      `${source?.label || source?.name || 'Volume source'}: ${source?.detail || source?.status || 'unavailable'}`
    )), [volumeMeta.sources]);
  const cftcStatus = cftcState.loading
    ? 'loading'
    : cftcStale
      ? 'delayed'
      : !cftcAvailable || !cftcOfficial || !cftcDecisionEligible
        ? 'unavailable'
        : cftcPartial
          ? 'delayed'
          : 'historical';
  const situationStatus = marketSituationState.loading
    ? 'loading'
    : marketSituationFreshness.status;
  const liquidityStatus = liquidityState.loading
    ? 'loading'
    : liquidityPartial
      ? 'delayed'
      : liquidityAvailable
        ? 'historical'
        : 'unavailable';
  const dashboardCardStatuses = useMemo(() => [
    {
      id: 'cftc-positioning',
      status: cftcStatus,
      date: cftcDate ? formatDate(cftcDate) : undefined,
      sourceDate: cftcDate || undefined,
      statusLabel: cftcStale ? 'STALE · REFERENCE ONLY' : cftcPartial ? 'PARTIAL' : undefined,
      detail: cftcDate ? `${cftcStale ? 'AS OF ' : ''}${formatDate(cftcDate)}` : undefined,
      diagnostics: [
        { label: 'Rows', value: `${Array.isArray(cftcState.data?.data) ? cftcState.data.data.length : 0}` },
        { label: 'As of', value: cftcDate ? formatDate(cftcDate) : 'Unavailable' },
        { label: 'Source', value: cftcOfficial ? 'Official CFTC' : 'Unverified' },
      ],
      issues: [
        cftcState.error ? `CFTC request: ${cftcState.error}` : null,
        cftcStale ? 'The latest CFTC snapshot is older than the freshness limit.' : null,
        cftcAvailable && !cftcOfficial ? 'The canonical official CFTC provenance is missing.' : null,
        cftcAvailable && cftcOfficial && !cftcDecisionEligible ? 'The official SPX row is decision-ineligible.' : null,
        cftcPartial ? 'One or more secondary CFTC contracts are unavailable.' : null,
      ].filter(Boolean),
    },
    {
      id: 'market-situation',
      status: situationStatus,
      date: marketSituationDate ? formatDate(marketSituationDate) : undefined,
      sourceDate: marketSituationDate || undefined,
      statusLabel: marketSituationFreshness.label,
      detail: marketSituationFreshness.detail,
      diagnostics: [
        { label: 'Signals', value: `${Array.isArray(marketSituationState.data?.data?.signals) ? marketSituationState.data.data.signals.length : 0}/4` },
        { label: 'As of', value: marketSituationFreshness.detail || 'Unavailable' },
      ],
      issues: marketSituationState.error
        ? [`Market Situation request: ${marketSituationState.error}`]
        : [],
    },
    {
      id: 'global-quads',
      status: quadsResource.data?.available ? 'historical' : quadsResource.initialLoading ? 'loading' : 'unavailable',
      date: formatDate(quadsResource.data?.date) || undefined,
      sourceDate: quadsResource.data?.date || undefined,
      detail: quadsResource.data?.date ? `AS OF ${formatDate(quadsResource.data.date)}` : 'UNAVAILABLE',
      diagnostics: [
        { label: 'Source', value: 'Hedgeye published tables' },
        { label: 'Ingestion', value: quadsResource.error ? 'Refresh unavailable' : quadsResource.data?.ingestion?.status || 'Checking' },
      ],
      issues: [
        ...(quadsResource.data?.ingestion?.issues?.length
          ? [`${quadsResource.data.ingestion.issues.length} emailed publication(s) need extraction review.`] : []),
        ...(quadsResource.data?.ingestion?.status === 'unavailable'
          ? ['Global Quads ingestion health is unavailable.'] : []),
        ...(quadsResource.error ? ['Global Quads refresh unavailable; retained readings are dated research.'] : []),
      ],
    },
    {
      id: 'dollar-liquidity',
      status: liquidityStatus,
      date: liquidityDate ? formatDate(liquidityDate) : undefined,
      sourceDate: liquidityDate || undefined,
      statusLabel: liquidityPartial ? 'PARTIAL' : undefined,
      detail: liquidityDate ? `${liquidityPartial ? 'AS OF ' : ''}${formatDate(liquidityDate)}` : undefined,
      diagnostics: [
        { label: 'Models', value: `${liquidityAvailable ? [liquidityGlobalModel, liquidityUsModel].filter(Boolean).length : 0}/2 available` },
        { label: 'As of', value: liquidityDate ? formatDate(liquidityDate) : 'Unavailable' },
      ],
      issues: [
        liquidityState.error ? `Liquidity request: ${liquidityState.error}` : null,
        liquidityPartial ? 'Some liquidity model inputs are provisional or incomplete.' : null,
      ].filter(Boolean),
    },
    {
      id: 'volume',
      status: volumeStatus,
      date: volumeMeta.asOf ? formatDate(volumeMeta.asOf) : undefined,
      sourceDate: volumeMeta.asOf || undefined,
      detail: volumeMeta.asOf
        ? `AS OF ${formatDate(volumeMeta.asOf) || String(volumeMeta.asOf).toUpperCase()}`
        : undefined,
      diagnostics: [
        { label: 'Sources', value: `${volumeMeta.sources.length}` },
        { label: 'Dataset', value: volumeMeta.datasetStatus || 'Checking' },
      ],
      issues: volumeSourceIssues,
    },
  ], [
    cftcDate,
    cftcAvailable,
    cftcDecisionEligible,
    cftcOfficial,
    cftcPartial,
    cftcStale,
    cftcState.data,
    cftcState.error,
    cftcStatus,
    liquidityAvailable,
    liquidityDate,
    liquidityGlobalModel,
    liquidityPartial,
    liquidityState.error,
    liquidityStatus,
    liquidityUsModel,
    marketSituationDate,
    marketSituationFreshness.detail,
    marketSituationFreshness.label,
    marketSituationState.data,
    marketSituationState.error,
    quadsResource.data,
    quadsResource.error,
    quadsResource.initialLoading,
    situationStatus,
    volumeMeta,
    volumeSourceIssues,
    volumeStatus,
  ]);

  useEffect(() => {
    onDashboardStatusChange?.(dashboardCardStatuses);
  }, [dashboardCardStatuses, onDashboardStatusChange]);

  return (
    <>
      <section className="efr-reference" aria-label="Normal / Reference">
        <div className="efr-reference__grid">
          <PreviewCard
            id="cftc"
            title="CFTC Positioning"
            status={cftcStatus}
            headerNote={cftcHeaderDate && (
              <time
                dateTime={cftcHeaderDate}
                title={`Positions as of ${formatCftcDate(cftcHeaderDate)}. Published weekly, usually Friday at 15:30 ET.${cftcLastChecked !== 'UNAVAILABLE' ? ` Last checked ${cftcLastChecked}.` : ''}`}
              >
                As of {formatCftcDate(cftcHeaderDate)}
              </time>
            )}
            onOpen={openPanel}
          >
            <CftcPreview data={cftcState.data} refreshFailed={Boolean(cftcState.error)} />
          </PreviewCard>
          <PreviewCard
            id="quads"
            title="Global Quads"
            status={quadsResource.data?.available ? 'historical' : 'unavailable'}
            onOpen={openPanel}
          >
            <QuadsPreview snapshot={quadsResource.data} loading={quadsResource.initialLoading} />
          </PreviewCard>
          <PreviewCard
            id="liquidity"
            title="Dollar Liquidity"
            status={liquidityStatus}
            onOpen={openPanel}
          >
            <LiquidityPreview data={liquidityState.data} />
            <PreviewCard
              id="volume"
              title={volumeTitle}
              status={volumeStatus}
              onOpen={openPanel}
            >
              <MarketVolumeTable
                onSourcesChange={handleVolumeSources}
                onHeaderNoteChange={handleVolumeHeader}
                onMetadataChange={handleVolumeMetadata}
                showAsOf={false}
              />
            </PreviewCard>
          </PreviewCard>
        </div>
      </section>
      {typeof document !== 'undefined' && createPortal(
        <FullReferencePanel
          activePanel={activePanel}
          onClose={closePanel}
          cftcState={cftcState}
          marketSituationState={marketSituationState}
          liquidityState={liquidityState}
          quadsResource={quadsResource}
          volumeTitle={volumeTitle}
        />,
        document.body,
      )}
    </>
  );
};

export { aggregateQuoteStatus, CftcPreview, CurrenciesPreview, getRowQuoteStatus, readManualRecord };
export default RadarReferencePanels;
