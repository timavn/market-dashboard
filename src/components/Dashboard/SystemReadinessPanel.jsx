import React, { useCallback, useEffect, useRef, useState } from 'react';
import { MarketDataService } from '../../services/api/marketDataService';
import { useTheme } from '../../context/ThemeContext';
import RefreshButton from '../common/RefreshButton';
import './SystemReadinessPanel.css';

const MAX_STATUS_AGE_MS = 30 * 1000;
const MAX_FUTURE_CLOCK_SKEW_MS = 30 * 1000;
const VALID_SERVICE_STATUSES = new Set(['online', 'offline', 'attention', 'unknown']);

const SERVICE_DEFINITIONS = [
  { id: 'dashboard', label: 'Dashboard', summary: 'API + UI' },
  { id: 'market-data', label: 'Market data', summary: 'Quotes + freshness' },
  { id: 'live-portfolio', label: 'Live portfolio', summary: 'IBKR session' },
  { id: 'hermes-gmail', label: 'Hermes / Gmail', summary: 'Agents + ingestion' },
];

const DETAIL_DEFINITIONS = {
  dashboard: [
    { id: 'api-server', label: 'API server', summary: 'Serves dashboard APIs' },
    { id: 'react-ui', label: 'React UI', summary: 'Renders the dashboard' },
  ],
  'market-data': [
    { id: 'primary-provider', label: 'Primary provider', summary: 'Live quote source' },
    { id: 'fresh-quote', label: 'Fresh quote', summary: 'Age and session check' },
  ],
  'live-portfolio': [
    { id: 'ibkr-sidecar', label: 'IBKR sidecar', summary: 'Dashboard-to-IBKR bridge' },
    { id: 'gateway-session', label: 'Gateway session', summary: 'Authenticated gateway link' },
    { id: 'managed-account', label: 'Managed account', summary: 'Position account access' },
    { id: 'fresh-session', label: 'Fresh session', summary: 'Recent verified update' },
  ],
  'hermes-gmail': [
    { id: 'hermes-analyst', label: 'Hermes Analyst', summary: 'Live portfolio analysis agent' },
    { id: 'hermes-developer', label: 'Hermes Developer', summary: 'System repair agent' },
    { id: 'hermes-security', label: 'Hermes Security', summary: 'Risk monitoring agent' },
    { id: 'gmail-ingestion', label: 'Gmail Ingestion', summary: 'Hedgeye attachment intake' },
  ],
};

const HEDGEYE_PRODUCT_DEFINITIONS = [
  { id: 'risk-ranges', label: 'Risk Ranges', summary: 'Daily LRR/HRR levels, Trend signals, and out-of-bucket names.' },
  { id: 'early-look', label: 'Early Look', summary: 'Early Trend changes across the published coverage list.' },
  { id: 'bitcoin-trend-tracker', label: 'Bitcoin Trend Tracker', summary: 'Crypto and related-equity Trend changes.' },
  { id: 'momo-tracker', label: 'MOMO Tracker', summary: 'Momentum coverage and Trend changes.' },
  { id: 'signal-strength', label: 'Signal Strength', summary: 'Security rankings plus added and removed names.' },
  { id: 'portfolio-solutions', label: 'Portfolio Solutions', summary: 'Rankings and top or bottom movers.' },
  { id: 'the-macro-show', label: 'The Macro Show', summary: 'Long, short, and neutral macro summary notes.' },
  { id: 'the-call', label: 'The Call', summary: 'Long, short, and neutral call summary notes.' },
  { id: 'real-time-alert', label: 'Real-Time Alert', summary: 'Published alert headlines, tickers, and signal phrases.' },
  { id: 'volume', label: 'Volume', summary: 'Market-volume snapshots and market-share data.' },
  { id: 'market-structure', label: 'Market Structure', summary: 'Market-structure snapshot data and notes.' },
  { id: 'cftc-positioning', label: 'CFTC Positioning', summary: 'Positioning metrics, weekly changes, and Z-scores.' },
  { id: 'etf-pro', label: 'ETF Pro', summary: 'Long and short ETF lists with reported changes.' },
  { id: 'inflation-nowcast', label: 'Inflation Nowcast', summary: 'Inflation forecast, outlook, and scenario notes.' },
];

const STATUS_META = {
  online: { label: 'Online', glyph: '✓' },
  offline: { label: 'Offline', glyph: '×' },
  attention: { label: 'Attention', glyph: '!' },
  unknown: { label: 'Unknown', glyph: '?' },
};

const DETAIL_STATUS_META = {
  online: { label: 'Online', glyph: '✓' },
  offline: { label: 'Offline', glyph: '×' },
  attention: { label: 'Attention', glyph: '!' },
  unknown: { label: 'Unknown', glyph: '?' },
};

function unknownProducts() {
  return HEDGEYE_PRODUCT_DEFINITIONS.map((product) => ({
    ...product,
    status: 'unknown',
    date: null,
    checkedAt: null,
  }));
}

function normalizeProductStatus(status) {
  switch (String(status || '').toLowerCase()) {
    case 'fresh':
    case 'current':
    case 'available':
    case 'indexed':
    case 'success':
      return 'online';
    case 'missing':
    case 'error':
    case 'failed':
    case 'invalid':
    case 'unavailable':
      return 'offline';
    case 'stale':
    case 'pending':
    case 'retained':
      return 'attention';
    default:
      return 'unknown';
  }
}

export function normalizeHedgeyeProducts(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || !payload.dataTypes || typeof payload.dataTypes !== 'object' || Array.isArray(payload.dataTypes)) {
    throw new Error('Hedgeye product status response was not valid.');
  }

  const checkedAt = payload.meta?.timestamp || payload.date || null;
  return HEDGEYE_PRODUCT_DEFINITIONS.map((product) => {
    const source = payload.dataTypes[product.id] || {};
    return {
      ...product,
      status: normalizeProductStatus(source.status),
      date: source.date || source.lastUpdated || null,
      checkedAt,
    };
  });
}

export function deriveProductsStatus(products = []) {
  if (!products.length || products.every((product) => product.status === 'unknown')) return 'unknown';
  if (products.every((product) => product.status === 'online')) return 'online';
  if (products.every((product) => product.status === 'offline')) return 'offline';
  return 'attention';
}

function unknownServices(reason = 'Status unavailable') {
  return SERVICE_DEFINITIONS.map((service) => ({
    ...service,
    status: 'unknown',
    reason,
    date: null,
    details: DETAIL_DEFINITIONS[service.id].map((detail) => ({
      ...detail,
      status: 'unknown',
      reason,
      date: null,
    })),
  }));
}

function cleanReason(value) {
  if (!value) return '';
  const reason = String(value).replace(/\s+/g, ' ').trim();
  return reason.length > 90 ? `${reason.slice(0, 87)}…` : reason;
}

function normalizeService(service, definition, checkedAt) {
  const rawStatus = String(service?.status || '').trim().toLowerCase();
  const status = VALID_SERVICE_STATUSES.has(rawStatus) ? rawStatus : 'unknown';
  const suppliedDetails = new Map(
    (Array.isArray(service?.details) ? service.details : [])
      .filter((detail) => detail && typeof detail === 'object')
      .map((detail) => [String(detail.id || ''), detail]),
  );
  const details = DETAIL_DEFINITIONS[definition.id].map((detailDefinition) => {
    const detail = suppliedDetails.get(detailDefinition.id);
    const rawDetailStatus = String(detail?.status || '').trim().toLowerCase();
    const detailStatus = VALID_SERVICE_STATUSES.has(rawDetailStatus)
      ? rawDetailStatus
      : 'unknown';
    return {
      ...detailDefinition,
      status: detailStatus,
      date: checkedAt,
      reason: detailStatus === 'online'
        ? ''
        : cleanReason(detail?.reason || 'Status unavailable'),
    };
  });
  return {
    ...definition,
    status,
    date: checkedAt,
    reason: status === 'online' ? '' : cleanReason(service?.reason),
    details,
  };
}

export function deriveSystemRailStatus(services = []) {
  const dashboard = services.find((service) => service.id === 'dashboard');
  if (!dashboard || dashboard.status === 'unknown') return 'unknown';
  if (dashboard.status === 'offline') return 'offline';
  return services.some((service) => service.status !== 'online') ? 'attention' : 'online';
}

export function derivePanelRailStatus(services = [], products = []) {
  const servicesStatus = deriveSystemRailStatus(services);
  if (servicesStatus === 'offline' || servicesStatus === 'unknown') return servicesStatus;
  return servicesStatus === 'attention' || deriveProductsStatus(products) !== 'online'
    ? 'attention'
    : 'online';
}

export function normalizeSystemStatus(payload, now = Date.now()) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('System status response was not a valid object.');
  }

  const checkedAt = new Date(payload.checkedAt || '');
  if (!Number.isFinite(checkedAt.getTime())) {
    throw new Error('System status response did not include a valid checkedAt timestamp.');
  }
  const statusAgeMs = now - checkedAt.getTime();
  if (statusAgeMs > MAX_STATUS_AGE_MS || statusAgeMs < -MAX_FUTURE_CLOCK_SKEW_MS) {
    throw new Error('System status response is stale.');
  }

  const suppliedServices = new Map(
    (Array.isArray(payload.services) ? payload.services : [])
      .filter((service) => service && typeof service === 'object')
      .map((service) => [String(service.id || ''), service]),
  );
  const services = SERVICE_DEFINITIONS.map((definition) => (
    normalizeService(suppliedServices.get(definition.id), definition, checkedAt.toISOString())
  ));

  return {
    checkedAt: checkedAt.toISOString(),
    services,
    railStatus: deriveSystemRailStatus(services),
  };
}

function formatStatusDate(value) {
  if (!value) return '—';
  const normalized = String(value).trim();
  const dateOnly = normalized.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (dateOnly) return dateOnly[1];
  const parsed = new Date(normalized);
  if (!Number.isFinite(parsed.getTime())) return '—';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(parsed);
  const values = Object.fromEntries(parts.map(({ type, value: partValue }) => [type, partValue]));
  return `${values.year}-${values.month}-${values.day}`;
}

function errorMessage(error) {
  return error?.response?.data?.error
    || error?.response?.data?.message
    || error?.message
    || 'Status unavailable';
}

const SystemReadinessPanel = ({
  open = true,
  onClose,
  onStatusChange,
}) => {
  const { theme } = useTheme();
  const [services, setServices] = useState(() => unknownServices());
  const [products, setProducts] = useState(() => unknownProducts());
  const [refreshing, setRefreshing] = useState(false);
  const [expandedServiceId, setExpandedServiceId] = useState(null);
  const [productsExpanded, setProductsExpanded] = useState(false);
  const requestIdRef = useRef(0);
  const onStatusChangeRef = useRef(onStatusChange);
  const servicesRef = useRef(services);
  const productsRef = useRef(products);
  const lastRailStatusRef = useRef(null);
  const panelRef = useRef(null);
  onStatusChangeRef.current = onStatusChange;

  const publishRailStatus = useCallback((status) => {
    if (lastRailStatusRef.current === status) return;
    lastRailStatusRef.current = status;
    onStatusChangeRef.current?.(status);
  }, []);

  const load = useCallback(async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const checking = unknownServices('Checking status');
    const checkingProducts = unknownProducts();
    servicesRef.current = checking;
    productsRef.current = checkingProducts;
    setServices(checking);
    setProducts(checkingProducts);
    setRefreshing(true);
    lastRailStatusRef.current = null;
    publishRailStatus('unknown');

    const systemRequest = MarketDataService.getSystemStatus()
      .then((payload) => {
        if (requestId !== requestIdRef.current) return;
        try {
          const normalized = normalizeSystemStatus(payload);
          servicesRef.current = normalized.services;
          setServices(normalized.services);
          publishRailStatus(derivePanelRailStatus(normalized.services, productsRef.current));
        } catch (loadError) {
          const unavailable = unknownServices(
            cleanReason(errorMessage(loadError)) || 'Status unavailable',
          );
          servicesRef.current = unavailable;
          setServices(unavailable);
          publishRailStatus('unknown');
        }
      })
      .catch((loadError) => {
        if (requestId !== requestIdRef.current) return;
        // Failed verification invalidates every previously displayed status.
        const unavailable = unknownServices(
          cleanReason(errorMessage(loadError)) || 'Status unavailable',
        );
        servicesRef.current = unavailable;
        setServices(unavailable);
        publishRailStatus('unknown');
      });

    const productsRequest = MarketDataService.getHedgeyeFreshness()
      .then((payload) => {
        if (requestId !== requestIdRef.current) return;
        try {
          const normalizedProducts = normalizeHedgeyeProducts(payload);
          productsRef.current = normalizedProducts;
          setProducts(normalizedProducts);
          publishRailStatus(derivePanelRailStatus(servicesRef.current, normalizedProducts));
        } catch {
          const unavailable = unknownProducts();
          productsRef.current = unavailable;
          setProducts(unavailable);
          publishRailStatus(derivePanelRailStatus(servicesRef.current, unavailable));
        }
      })
      .catch(() => {
        if (requestId !== requestIdRef.current) return;
        const unavailable = unknownProducts();
        productsRef.current = unavailable;
        setProducts(unavailable);
        publishRailStatus(derivePanelRailStatus(servicesRef.current, unavailable));
      });

    await Promise.allSettled([systemRequest, productsRequest]);

    if (requestId === requestIdRef.current) setRefreshing(false);
  }, [publishRailStatus]);

  useEffect(() => {
    if (!open) return undefined;
    load();
    return () => {
      requestIdRef.current += 1;
    };
  }, [load, open]);

  useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined;
    const handleOutsideMouseDown = (event) => {
      if (panelRef.current && !panelRef.current.contains(event.target)) onClose?.();
    };
    document.addEventListener('mousedown', handleOutsideMouseDown);
    return () => document.removeEventListener('mousedown', handleOutsideMouseDown);
  }, [onClose, open]);

  if (!open) return null;

  return (
    <section
      ref={panelRef}
      className={`sr-panel ${theme === 'dark' ? 'sr-panel--dark' : ''}`}
      role={open ? 'dialog' : undefined}
      aria-label={open ? 'Systems' : undefined}
      aria-busy={refreshing || undefined}
    >
      <header className="sr-panel__toolbar">
        <h2>Systems</h2>
        <RefreshButton
          label="Refresh systems"
          title="Refresh systems"
          loading={refreshing}
          iconOnly
          onClick={load}
        />
      </header>

      <ul className="sr-services" aria-label="Current system status">
        {services.map((service) => {
          const meta = STATUS_META[service.status];
          const expanded = expandedServiceId === service.id;
          const checklistId = `sr-details-${service.id}`;
          return (
            <li data-status={service.status} key={service.id}>
              <div className="sr-service__summary">
                <button
                  type="button"
                  className="sr-service__toggle sr-service__trigger"
                  aria-expanded={expanded}
                  aria-controls={checklistId}
                  aria-label={`${expanded ? 'Collapse' : 'Expand'} ${service.label} checklist`}
                  onClick={() => {
                    setExpandedServiceId(expanded ? null : service.id);
                    setProductsExpanded(false);
                  }}
                >
                  <span className="sr-chevron" aria-hidden="true" />
                  <strong>{service.label}</strong>
                </button>
                <span className="sr-service__date">{formatStatusDate(service.date)}</span>
                <span className="sr-service__scope">{service.summary}</span>
                <span className="sr-service__result">
                  <span className="sr-service__status">
                    <i aria-hidden="true">{meta.glyph}</i>
                    {meta.label}
                  </span>
                </span>
              </div>
              {expanded ? (
                <ul
                  className="sr-service__details"
                  id={checklistId}
                  aria-label={`${service.label} checklist`}
                >
                  <li className="sr-section__column-headings" aria-hidden="true">
                    <span>Service</span>
                    <span>Date</span>
                    <span>Description</span>
                    <span>Status</span>
                  </li>
                  {service.details.map((detail) => {
                    const detailMeta = DETAIL_STATUS_META[detail.status];
                    return (
                      <li data-status={detail.status} key={detail.id}>
                        <span>{detail.label}</span>
                        <span className="sr-service__detail-date">{formatStatusDate(detail.date)}</span>
                        <span className="sr-service__detail-scope">{detail.summary}</span>
                        <span className="sr-service__detail-result">
                          <span className="sr-service__detail-status">
                            <i aria-hidden="true">{detailMeta.glyph}</i>
                            {detailMeta.label}
                          </span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </li>
          );
        })}
        <li className="sr-products-row" data-status={deriveProductsStatus(products)}>
          <div className="sr-service__summary">
            <button
              type="button"
              className="sr-service__toggle sr-service__trigger"
              aria-expanded={productsExpanded}
              aria-controls="sr-products-list"
              aria-label={`${productsExpanded ? 'Collapse' : 'Expand'} Products`}
              onClick={() => {
                setProductsExpanded(!productsExpanded);
                setExpandedServiceId(null);
              }}
            >
              <span className="sr-chevron" aria-hidden="true" />
              <strong>Products</strong>
            </button>
            <span className="sr-service__date">{formatStatusDate(products[0]?.checkedAt)}</span>
            <span className="sr-service__scope">Hedgeye research feeds</span>
            <span className="sr-service__result">
              <span className="sr-service__status">
                <i aria-hidden="true">{STATUS_META[deriveProductsStatus(products)].glyph}</i>
                {STATUS_META[deriveProductsStatus(products)].label}
              </span>
            </span>
          </div>
          {productsExpanded ? (
            <ul
              className="sr-product__details"
              id="sr-products-list"
              aria-label="Hedgeye products pulled by the dashboard"
            >
              <li className="sr-section__column-headings" aria-hidden="true">
                <span>Service</span>
                <span>Date</span>
                <span>Description</span>
                <span>Status</span>
              </li>
              {products.map((product) => {
                const meta = STATUS_META[product.status];
                return (
                  <li data-status={product.status} key={product.id}>
                    <strong>{product.label}</strong>
                    <span className="sr-product__date">{formatStatusDate(product.date)}</span>
                    <span className="sr-product__description">{product.summary}</span>
                    <span className="sr-product__status">
                      <i aria-hidden="true">{meta.glyph}</i>
                      {meta.label}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </li>
      </ul>
    </section>
  );
};

export {
  DETAIL_DEFINITIONS,
  DETAIL_STATUS_META,
  HEDGEYE_PRODUCT_DEFINITIONS,
  SERVICE_DEFINITIONS,
  STATUS_META,
};
export default SystemReadinessPanel;
