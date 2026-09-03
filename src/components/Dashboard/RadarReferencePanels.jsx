import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, X } from 'lucide-react';
import { MarketDataService } from '../../services/api/marketDataService';
import CFTCNetLongCard from './CFTCNetLongCard';
import DelayedDataMarker from './DelayedDataMarker';
import DollarLiquidityModels from './DollarLiquidityModels';
import GlobalQuadsCard from './GlobalQuadsCard';
import MarketSituationReportCard, {
  getMarketSituationFreshness,
} from './MarketSituationReportCard';
import MarketVolumeTable from './MarketVolumeTable';
import PersistentSurface from '../common/PersistentSurface';
import { useDashboardResource } from '../../hooks/useDashboardResource';
import { useMarketStructureReport } from '../../hooks/useMarketStructureReport';

const QUADS_STORAGE_KEY = 'quadForecast_v3';
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

const getRowQuoteStatus = (row, providerStatus) => {
  if (!row || !['current', 'delayed', 'historical', 'reference'].includes(row.availability)) return 'unavailable';
  const source = String(row.source || row.provider || '').toLowerCase();
  const quoteMode = String(row.dataType || row.quoteMode || row.freshness || '').toLowerCase();
  const quoteAsOf = row.quoteAsOf || row.timestamp || row.asOf;
  const quoteDate = quoteAsOf ? new Date(quoteAsOf) : null;
  const isRetainedReference = Boolean(
    row.availability === 'reference'
      && row.displayDelayed === true
      && row.displayOnly === true
      && row.executable === false
      && row.lastVerifiedAt
  );
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
  // A retained row is display-only and explicitly labeled delayed. It was
  // accepted while verified, so a later refresh failure should not erase it.
  if (isRetainedReference) return 'delayed';
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
  // Provider health is newer evidence about liveness, not a reason to erase
  // an already timestamped observation from this informational table.
  if (source.includes('ibkr') && providerExplicitlyOffline) return 'delayed';
  if (row.availability === 'delayed' && quoteMode === 'delayed') {
    const symbol = String(row.symbol || row.ticker || '').toUpperCase();
    const maxAge = CONTINUOUS_CRYPTO_SYMBOLS.has(symbol)
      ? 2 * 60 * 60 * 1000
      : 4 * 24 * 60 * 60 * 1000;
    return quoteAge <= maxAge ? 'delayed' : 'unavailable';
  }
  if (row.availability === 'historical' || quoteMode.includes('historical') || source.includes('fred')) return 'historical';
  if (
    row.availability === 'current' &&
    source.includes('ibkr') &&
    ['live', 'unknown'].includes(quoteMode)
  ) return quoteAge <= IBKR_LIVE_DISPLAY_MAX_AGE_MS ? 'live' : 'delayed';
  return 'unavailable';
};

const aggregateQuoteStatus = (rows, providerStatus) => {
  const statuses = (Array.isArray(rows) ? rows : []).map((row) => getRowQuoteStatus(row, providerStatus));
  const eligible = statuses.filter((status) => status !== 'unavailable');
  if (eligible.length === 0) return 'unavailable';
  if (eligible.length !== statuses.length) return 'mixed';
  if (new Set(eligible).size > 1) return 'mixed';
  if (eligible.includes('delayed')) return 'delayed';
  if (eligible.includes('historical')) return 'historical';
  return 'live';
};

const PreviewCard = ({
  id,
  title,
  status,
  onOpen,
  children,
}) => (
  <section
    className={`efr-reference-card efr-reference-card--${id}`}
    aria-labelledby={`efr-reference-${id}`}
    data-status={status}
  >
    <header className="efr-reference-card__header">
      <button
        type="button"
        className="efr-reference-card__title"
        onClick={() => onOpen(id)}
        id={`efr-reference-${id}`}
      >
        {title}
      </button>
    </header>
    <div className="efr-reference-card__body">{children}</div>
    <button type="button" className="efr-reference-card__open" onClick={() => onOpen(id)}>
      Full view <ArrowRight size={12} aria-hidden="true" />
    </button>
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
                    <DelayedDataMarker status={status} title={delayedTitle} updatedAt={quoteAsOf} />
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

const CftcPreview = ({ data }) => {
  const rows = Array.isArray(data?.data) ? data.data.slice(0, 5) : [];
  if (rows.length === 0) return <EmptyPreview />;
  return (
    <table className="efr-mini-table">
      <thead><tr><th>Asset</th><th>Net position</th><th>W/W</th><th>Z-score</th></tr></thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={`${row.metric || 'position'}-${index}`}>
            <td>{row.metric || '—'}</td>
            <td>{isFiniteNumber(row.latest) ? Number(row.latest).toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—'}</td>
            <td className={isFiniteNumber(row.wwChg) && Number(row.wwChg) !== 0 ? (Number(row.wwChg) > 0 ? 'is-positive' : 'is-negative') : ''}>
              {isFiniteNumber(row.wwChg) ? `${Number(row.wwChg) > 0 ? '+' : ''}${Number(row.wwChg).toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '—'}
            </td>
            <td>{formatNumber(row.zScore1Y, 2)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

const quarterSortValue = (quarter) => {
  const match = String(quarter).match(/^(\d)Q(\d{2})E?$/);
  return match ? Number(match[2]) * 10 + Number(match[1]) : -1;
};

const QuadsPreview = ({ record }) => {
  const preferredRows = ['G20_MODE/MEDIAN', 'United States', 'China', 'Germany', 'Japan'];
  const availableRows = preferredRows.filter((key) => {
    const row = record.rows?.[key];
    return row && Object.values(row).some((value) => String(value || '').trim() !== '');
  });
  const quarters = Array.from(new Set(
    availableRows.flatMap((key) => Object.keys(record.rows[key] || {}))
  )).filter((key) => quarterSortValue(key) >= 0).sort((a, b) => quarterSortValue(a) - quarterSortValue(b)).slice(-3);

  if (availableRows.length === 0 || quarters.length === 0) {
    return <EmptyPreview>No manual quad readings entered</EmptyPreview>;
  }

  return (
    <table className="efr-mini-table efr-mini-table--quads">
      <thead><tr><th>Market</th>{quarters.map((quarter) => <th key={quarter}>{quarter}</th>)}</tr></thead>
      <tbody>
        {availableRows.map((key) => (
          <tr key={key}>
            <td>{key === 'G20_MODE/MEDIAN' ? 'G20 median' : key}</td>
            {quarters.map((quarter) => {
              const quad = record.rows[key]?.[quarter];
              return <td key={quarter}><span className={quad ? `efr-quad efr-quad--${quad}` : ''}>{quad || '—'}</span></td>;
            })}
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
}) => {
  const dialogRef = useRef(null);
  const [lastPanel, setLastPanel] = useState(activePanel);

  useEffect(() => {
    if (activePanel) setLastPanel(activePanel);
  }, [activePanel]);

  useEffect(() => {
    if (!activePanel) return undefined;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
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
      document.body.style.overflow = originalOverflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [activePanel, onClose]);

  return (
    <PersistentSurface
      active={Boolean(activePanel)}
      className="efr-reference-overlay"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section ref={dialogRef} className="efr-reference-dialog" role="dialog" aria-modal="true" aria-labelledby="efr-reference-dialog-title">
        <header className="efr-reference-dialog__header">
          <div>
            <span>Normal / Reference</span>
            <h2 id="efr-reference-dialog-title">{PANEL_TITLES[activePanel || lastPanel]}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label={`Close ${PANEL_TITLES[activePanel || lastPanel] || 'reference panel'}`} autoFocus>
            <X size={18} aria-hidden="true" />
          </button>
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
            <GlobalQuadsCard />
          </PersistentSurface>
          <PersistentSurface active={activePanel === 'liquidity'}>
            <DollarLiquidityModels resourceState={liquidityState} />
          </PersistentSurface>
          <PersistentSurface active={activePanel === 'volume'}>
            <MarketVolumeTable />
          </PersistentSurface>
        </div>
      </section>
    </PersistentSurface>
  );
};

const RadarReferencePanels = ({ onDashboardStatusChange }) => {
  const [activePanel, setActivePanel] = useState(null);
  const [volumeMeta, setVolumeMeta] = useState({ sources: [], asOf: null, datasetStatus: null });
  const [quadsRecord, setQuadsRecord] = useState(() => readManualRecord(QUADS_STORAGE_KEY));
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
    getObservedAt: (payload) => payload.date || payload.asOf || null,
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

  const refreshManualRecords = useCallback(() => {
    setQuadsRecord(readManualRecord(QUADS_STORAGE_KEY));
  }, []);

  useEffect(() => {
    window.addEventListener('storage', refreshManualRecords);
    window.addEventListener('focus', refreshManualRecords);
    return () => {
      window.removeEventListener('storage', refreshManualRecords);
      window.removeEventListener('focus', refreshManualRecords);
    };
  }, [refreshManualRecords]);

  const openPanel = useCallback((panelId) => {
    lastTriggerRef.current = document.activeElement;
    setActivePanel(panelId);
  }, []);

  const closePanel = useCallback(() => {
    setActivePanel(null);
    refreshManualRecords();
    window.requestAnimationFrame(() => lastTriggerRef.current?.focus?.());
  }, [refreshManualRecords]);

  const cftcDate = cftcState.data?.date || cftcState.data?.asOf || null;
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
    if (volumeMeta.datasetStatus === 'missing' || volumeMeta.sources.some((source) => (
      ['defective', 'inactive', 'offline'].includes(source.status)
    ))) {
      return 'unavailable';
    }
    if (volumeMeta.datasetStatus === 'provisional') return 'delayed';
    return 'historical';
  }, [volumeMeta.datasetStatus, volumeMeta.sources]);
  const handleVolumeSources = useCallback((sources) => {
    setVolumeMeta((current) => ({ ...current, sources: Array.isArray(sources) ? sources : [] }));
  }, []);
  const handleVolumeHeader = useCallback((asOf) => {
    setVolumeMeta((current) => ({ ...current, asOf: current.asOf || asOf || null }));
  }, []);
  const handleVolumeMetadata = useCallback((metadata) => {
    setVolumeMeta((current) => ({
      ...current,
      asOf: metadata?.asOfTradingDate || current.asOf,
      datasetStatus: metadata?.status || null,
    }));
  }, []);
  const volumeSourceIssues = useMemo(() => volumeMeta.sources
    .filter((source) => ['defective', 'inactive', 'offline', 'missing', 'error'].includes(
      String(source?.status || '').toLowerCase(),
    ))
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
      status: 'manual',
      date: quadsRecord.lastEditedAt ? formatDate(quadsRecord.lastEditedAt) : undefined,
      sourceDate: quadsRecord.lastEditedAt || undefined,
      detail: quadsRecord.lastEditedAt ? formatDate(quadsRecord.lastEditedAt) : 'NO AS-OF',
      diagnostics: [
        { label: 'Rows', value: `${Object.keys(quadsRecord.rows || {}).length}` },
        { label: 'Last edit', value: quadsRecord.lastEditedAt ? formatDate(quadsRecord.lastEditedAt) : 'No as-of' },
      ],
      issues: [],
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
      statusLabel: volumeMeta.datasetStatus === 'provisional' ? 'PROVISIONAL' : undefined,
      detail: volumeMeta.asOf
        ? `${volumeMeta.datasetStatus === 'provisional' ? 'AS OF ' : ''}${formatDate(volumeMeta.asOf) || String(volumeMeta.asOf).toUpperCase()}`
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
    quadsRecord,
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
            onOpen={openPanel}
          >
            <CftcPreview data={cftcState.data} />
          </PreviewCard>
          <PreviewCard
            id="quads"
            title="Global Quads"
            status="manual"
            onOpen={openPanel}
          >
            <QuadsPreview record={quadsRecord} />
          </PreviewCard>
          <PreviewCard
            id="liquidity"
            title="Dollar Liquidity"
            status={liquidityStatus}
            onOpen={openPanel}
          >
            <LiquidityPreview data={liquidityState.data} />
          </PreviewCard>
          <PreviewCard
            id="volume"
            title="Volume"
            status={volumeStatus}
            onOpen={openPanel}
          >
            <MarketVolumeTable
              onSourcesChange={handleVolumeSources}
              onHeaderNoteChange={handleVolumeHeader}
              onMetadataChange={handleVolumeMetadata}
            />
          </PreviewCard>
        </div>
      </section>
      <FullReferencePanel
        activePanel={activePanel}
        onClose={closePanel}
        cftcState={cftcState}
        marketSituationState={marketSituationState}
        liquidityState={liquidityState}
      />
    </>
  );
};

export { aggregateQuoteStatus, CurrenciesPreview, getRowQuoteStatus, readManualRecord };
export default RadarReferencePanels;
