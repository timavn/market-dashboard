import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, X } from 'lucide-react';
import { MarketDataService } from '../../services/api/marketDataService';
import CFTCNetLongCard from './CFTCNetLongCard';
import DollarLiquidityModels from './DollarLiquidityModels';
import GlobalQuadsCard from './GlobalQuadsCard';
import MarketVolumeTable from './MarketVolumeTable';
import StyleFactorPerformanceCard from './StyleFactorPerformanceCard';
import DataStatusChip from './DataStatusChip';

const STYLE_STORAGE_KEY = 'styleFactorPerformanceData';
const QUADS_STORAGE_KEY = 'quadForecast_v3';
const ANALYTICS_REFRESH_MS = 15 * 60 * 1000;
const CONTINUOUS_CRYPTO_SYMBOLS = new Set(['BTC', 'ETH', 'BNB', 'ADA', 'SOL', 'XRP']);

const PANEL_TITLES = {
  cftc: 'CFTC Positioning',
  factors: 'Style Factors',
  quads: 'Global Quads',
  liquidity: 'Dollar Liquidity',
  volume: 'Volume',
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
  if (!row || !['current', 'delayed', 'historical'].includes(row.availability)) return 'unavailable';
  const source = String(row.source || row.provider || '').toLowerCase();
  const quoteMode = String(row.dataType || row.quoteMode || row.freshness || '').toLowerCase();
  const quoteAsOf = row.quoteAsOf || row.timestamp || row.asOf;
  const quoteDate = quoteAsOf ? new Date(quoteAsOf) : null;
  const providerDate = providerStatus?.timestamp || providerStatus?.responseTimestamp;
  const providerAge = providerDate ? Date.now() - new Date(providerDate).getTime() : Infinity;
  const lastQuoteAt = providerStatus?.ibkr?.lastQuoteAt;
  const heartbeatAge = lastQuoteAt ? Date.now() - new Date(lastQuoteAt).getTime() : Infinity;
  const ibkrOffline =
    providerStatus?.statusRefreshDelayed ||
    providerStatus?.ibkr?.connected !== true ||
    !Number.isFinite(providerAge) || providerAge < -30000 || providerAge > 30000 ||
    !Number.isFinite(heartbeatAge) || heartbeatAge < -60000 || heartbeatAge > 60000;

  if (!quoteDate || Number.isNaN(quoteDate.getTime())) return 'unavailable';
  const quoteAge = Date.now() - quoteDate.getTime();
  if (quoteAge < -5 * 60 * 1000) return 'unavailable';
  if (source.includes('ibkr') && ibkrOffline) return 'unavailable';
  if (row.freshness && row.freshness !== 'current') return 'unavailable';
  if (row.sourceStatus && row.sourceStatus !== 'current') return 'unavailable';
  if (/stale|offline|cache|mock|seed|synthetic|fallback|inferred|portfolio/i.test(
    [quoteMode, row.warning, row.error, row.entitlementStatus].filter(Boolean).join(' ')
  )) {
    return 'unavailable';
  }
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
    ['live', 'unknown'].includes(quoteMode) &&
    quoteAge <= 60 * 1000
  ) return 'live';
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
  statusLabel,
  statusDetail,
  statusIssues,
  onOpen,
  children,
}) => (
  <section className={`efr-reference-card efr-reference-card--${id}`} aria-labelledby={`efr-reference-${id}`}>
    <header className="efr-reference-card__header">
      <button
        type="button"
        className="efr-reference-card__title"
        onClick={() => onOpen(id)}
        id={`efr-reference-${id}`}
      >
        {title}
      </button>
      <DataStatusChip
        status={status}
        label={statusLabel}
        detail={statusDetail}
        context={title}
        issues={statusIssues}
        className="efr-reference-card__status"
        compact
        indicatorOnly
      />
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
          return (
            <tr key={row.symbol || row.name}>
              <td>{row.name || row.symbol}</td>
              <td>{available ? formatNumber(row.price, Number(row.price) < 10 ? 3 : 2) : '—'}</td>
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

const StylePreview = ({ record }) => {
  const periods = ['1D', '1M', 'YTD'];
  const rows = Object.entries(record.rows || {})
    .filter(([key, value]) => key !== 'lastEditedAt' && value && typeof value === 'object')
    .filter(([, value]) => periods.some((period) => isFiniteNumber(value[period])))
    .slice(0, 5);
  if (rows.length === 0) return <EmptyPreview>No manual factor readings entered</EmptyPreview>;
  return (
    <table className="efr-mini-table">
      <thead><tr><th>Factor</th>{periods.map((period) => <th key={period}>{period}</th>)}</tr></thead>
      <tbody>
        {rows.map(([label, values]) => (
          <tr key={label}>
            <td>{label}</td>
            {periods.map((period) => (
              <td key={period} className={isFiniteNumber(values[period]) && Number(values[period]) !== 0 ? (Number(values[period]) > 0 ? 'is-positive' : 'is-negative') : ''}>
                {formatSigned(values[period], '%')}
              </td>
            ))}
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

const FullReferencePanel = ({ activePanel, onClose }) => {
  const title = PANEL_TITLES[activePanel];
  const dialogRef = useRef(null);
  const panel = useMemo(() => {
    switch (activePanel) {
      case 'cftc':
        return <CFTCNetLongCard />;
      case 'factors':
        return <StyleFactorPerformanceCard />;
      case 'quads':
        return <GlobalQuadsCard />;
      case 'liquidity':
        return <DollarLiquidityModels />;
      case 'volume':
        return <MarketVolumeTable />;
      default:
        return null;
    }
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

  if (!activePanel) return null;
  return (
    <div className="efr-reference-overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} className="efr-reference-dialog" role="dialog" aria-modal="true" aria-labelledby="efr-reference-dialog-title">
        <header className="efr-reference-dialog__header">
          <div>
            <span>Normal / Reference</span>
            <h2 id="efr-reference-dialog-title">{title}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label={`Close ${title}`} autoFocus>
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <div className="efr-reference-dialog__body">{panel}</div>
      </section>
    </div>
  );
};

const RadarReferencePanels = () => {
  const [activePanel, setActivePanel] = useState(null);
  const [cftcState, setCftcState] = useState({ data: null, loading: true, error: null });
  const [liquidityState, setLiquidityState] = useState({ data: null, loading: true, error: null });
  const [volumeMeta, setVolumeMeta] = useState({ sources: [], asOf: null, datasetStatus: null });
  const [styleRecord, setStyleRecord] = useState(() => readManualRecord(STYLE_STORAGE_KEY));
  const [quadsRecord, setQuadsRecord] = useState(() => readManualRecord(QUADS_STORAGE_KEY));
  const lastTriggerRef = useRef(null);

  const refreshManualRecords = useCallback(() => {
    setStyleRecord(readManualRecord(STYLE_STORAGE_KEY));
    setQuadsRecord(readManualRecord(QUADS_STORAGE_KEY));
  }, []);

  useEffect(() => {
    let active = true;
    const fetchReferenceData = async () => {
      const backendUrl = process.env.REACT_APP_BACKEND_URL || 'http://localhost:3001';
      setCftcState((current) => ({ ...current, loading: !current.data, error: null }));
      setLiquidityState((current) => ({ ...current, loading: !current.data, error: null }));

      const [cftcResult, liquidityResult] = await Promise.allSettled([
        fetch(`${backendUrl}/api/hedgeye/snapshot/cftc-positioning`).then(async (response) => {
          const payload = await response.json();
          if (!response.ok) throw new Error(payload?.error || `CFTC request failed (${response.status})`);
          return payload;
        }),
        MarketDataService.getDollarLiquidityModels(),
      ]);
      if (!active) return;

      setCftcState(cftcResult.status === 'fulfilled'
        ? { data: cftcResult.value, loading: false, error: null }
        : { data: null, loading: false, error: cftcResult.reason?.message || 'Unavailable' });
      setLiquidityState(liquidityResult.status === 'fulfilled'
        ? { data: liquidityResult.value, loading: false, error: null }
        : { data: null, loading: false, error: liquidityResult.reason?.message || 'Unavailable' });
    };

    fetchReferenceData();
    const interval = window.setInterval(fetchReferenceData, ANALYTICS_REFRESH_MS);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
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
  const liquidityDate =
    liquidityState.data?.models?.us?.latest?.date ||
    liquidityState.data?.models?.global?.latest?.date ||
    null;
  const cftcAvailable = Array.isArray(cftcState.data?.data) && cftcState.data.data.length > 0;
  const liquidityAvailable = Boolean(
    liquidityState.data?.models?.global?.latest || liquidityState.data?.models?.us?.latest
  );
  const cftcAgeMs = cftcDate ? Date.now() - new Date(cftcDate).getTime() : Infinity;
  const cftcStale = cftcAvailable && (!Number.isFinite(cftcAgeMs) || cftcAgeMs > 10 * 24 * 60 * 60 * 1000);
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
  const volumeSourceIssues = volumeMeta.sources
    .filter((source) => ['defective', 'inactive', 'offline', 'missing', 'error'].includes(
      String(source?.status || '').toLowerCase(),
    ))
    .map((source) => (
      `${source?.label || source?.name || 'Volume source'}: ${source?.detail || source?.status || 'unavailable'}`
    ));

  return (
    <>
      <section className="efr-reference" aria-label="Normal / Reference">
        <div className="efr-reference__grid">
          <PreviewCard
            id="cftc"
            title="CFTC Positioning"
            status={cftcState.loading ? 'loading' : cftcStale ? 'delayed' : cftcAvailable ? 'historical' : 'unavailable'}
            statusLabel={cftcStale ? 'STALE' : undefined}
            statusDetail={cftcDate ? `${cftcStale ? 'AS OF ' : ''}${formatDate(cftcDate)}` : undefined}
            statusIssues={cftcState.error ? [`CFTC request: ${cftcState.error}`] : []}
            onOpen={openPanel}
          >
            <CftcPreview data={cftcState.data} />
          </PreviewCard>
          <PreviewCard
            id="factors"
            title="Style Factors"
            status="manual"
            statusDetail={styleRecord.lastEditedAt ? formatDate(styleRecord.lastEditedAt) : 'NO AS-OF'}
            onOpen={openPanel}
          >
            <StylePreview record={styleRecord} />
          </PreviewCard>
          <PreviewCard
            id="quads"
            title="Global Quads"
            status="manual"
            statusDetail={quadsRecord.lastEditedAt ? formatDate(quadsRecord.lastEditedAt) : 'NO AS-OF'}
            onOpen={openPanel}
          >
            <QuadsPreview record={quadsRecord} />
          </PreviewCard>
          <PreviewCard
            id="liquidity"
            title="Dollar Liquidity"
            status={liquidityState.loading ? 'loading' : liquidityPartial ? 'delayed' : liquidityAvailable ? 'historical' : 'unavailable'}
            statusLabel={liquidityPartial ? 'PARTIAL' : undefined}
            statusDetail={liquidityDate ? `${liquidityPartial ? 'AS OF ' : ''}${formatDate(liquidityDate)}` : undefined}
            statusIssues={liquidityState.error ? [`Liquidity request: ${liquidityState.error}`] : []}
            onOpen={openPanel}
          >
            <LiquidityPreview data={liquidityState.data} />
          </PreviewCard>
          <PreviewCard
            id="volume"
            title="Volume"
            status={volumeStatus}
            statusLabel={volumeMeta.datasetStatus === 'provisional' ? 'PROVISIONAL' : undefined}
            statusDetail={volumeMeta.asOf
              ? `${volumeMeta.datasetStatus === 'provisional' ? 'AS OF ' : ''}${formatDate(volumeMeta.asOf) || String(volumeMeta.asOf).toUpperCase()}`
              : undefined}
            statusIssues={volumeSourceIssues}
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
      />
    </>
  );
};

export { aggregateQuoteStatus, CurrenciesPreview, getRowQuoteStatus, readManualRecord };
export default RadarReferencePanels;
