export const DASHBOARD_CARD_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'volatility',
    label: 'Volatility',
    summary: '3M volatility map',
  }),
  Object.freeze({
    id: 'usd',
    label: 'USD',
    summary: 'Currencies + correlations',
  }),
  Object.freeze({
    id: 'market-backdrop',
    label: 'Market Backdrop',
    summary: 'Global markets + returns',
  }),
  Object.freeze({
    id: 'cftc-positioning',
    label: 'CFTC Positioning',
    summary: 'Futures positioning snapshot',
  }),
  Object.freeze({
    id: 'market-situation',
    label: 'Market Situation',
    summary: 'Four-signal research report',
  }),
  Object.freeze({
    id: 'global-quads',
    label: 'Global Quads',
    summary: 'Published macro readings',
  }),
  Object.freeze({
    id: 'dollar-liquidity',
    label: 'Dollar Liquidity',
    summary: 'Liquidity models',
  }),
  Object.freeze({
    id: 'volume',
    label: 'Volume',
    summary: 'Market-volume snapshots',
  }),
]);

const VALID_DASHBOARD_STATUSES = new Set([
  'live',
  'delayed',
  'mixed',
  'historical',
  'closed',
  'manual',
  'loading',
  'offline',
  'unavailable',
]);

const CLOSED_REFERENCE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export const DASHBOARD_SYSTEM_STATUS_META = Object.freeze({
  online: Object.freeze({
    label: 'Online',
    summary: 'Verified live data is current.',
  }),
  closed: Object.freeze({
    label: 'Closed',
    summary: 'Showing the most recent completed reference close; no live update is expected for this source.',
  }),
  attention: Object.freeze({
    label: 'Attention',
    summary: 'Data is available but requires attention; see the diagnostics below.',
  }),
  error: Object.freeze({
    label: 'Error',
    summary: 'Verified data is unavailable or the provider reported an error.',
  }),
  unknown: Object.freeze({
    label: 'Checking',
    summary: 'The card status has not been verified yet.',
  }),
});

const isRecentClosedReference = (sourceDate, now = Date.now()) => {
  const parsed = new Date(sourceDate || '');
  if (!Number.isFinite(parsed.getTime())) return false;
  const ageMs = now - parsed.getTime();
  return ageMs >= -30 * 1000 && ageMs <= CLOSED_REFERENCE_MAX_AGE_MS;
};

const hasClosedSessionReference = ({ marketSession, sourceDate, issues = [], now } = {}) => (
  marketSession === 'closed'
  && isRecentClosedReference(sourceDate, now)
  && (!Array.isArray(issues) || issues.length === 0)
);

export const getDashboardSystemStatus = (status, options = {}) => {
  switch (status) {
    case 'live':
      return 'online';
    case 'delayed':
    case 'mixed':
      return hasClosedSessionReference(options) ? 'closed' : 'attention';
    case 'manual':
      return 'closed';
    case 'historical':
      return options.issues?.length ? 'attention' : 'closed';
    case 'closed':
      return 'closed';
    case 'offline':
    case 'unavailable':
      return 'error';
    case 'loading':
    default:
      return 'unknown';
  }
};

export const getDashboardDataStatus = (status, options = {}) => {
  switch (getDashboardSystemStatus(status, options)) {
    case 'online':
      return 'live';
    case 'attention':
      return 'mixed';
    case 'closed':
      return 'closed';
    case 'error':
      return 'unavailable';
    case 'unknown':
    default:
      return 'loading';
  }
};

const normalizeDiagnostic = (item) => {
  if (typeof item === 'string') {
    const value = item.trim();
    return value ? { label: null, value } : null;
  }
  if (!item || typeof item !== 'object') return null;
  const rawValue = item.value ?? item.detail;
  if (rawValue == null) return null;
  const value = String(rawValue).trim();
  if (!value) return null;
  const label = item.label == null ? null : String(item.label).trim() || null;
  return { label, value };
};

const cleanDiagnostics = (value) => (Array.isArray(value) ? value : [])
  .map(normalizeDiagnostic)
  .filter(Boolean)
  .slice(0, 4);

const cleanIssues = (value) => (Array.isArray(value) ? value : [])
  .map((item) => (item == null ? '' : String(item).trim()))
  .filter(Boolean)
  .slice(0, 3);

export const normalizeDashboardCardStatus = (value, definition) => {
  const source = value && typeof value === 'object' ? value : {};
  const status = String(source.status || '').trim().toLowerCase();
  return {
    ...definition,
    status: VALID_DASHBOARD_STATUSES.has(status) ? status : 'unavailable',
    label: definition.label,
    summary: source.summary || definition.summary,
    date: source.date || undefined,
    statusLabel: source.statusLabel || undefined,
    detail: source.detail || undefined,
    sourceDate: source.sourceDate || undefined,
    diagnostics: cleanDiagnostics(source.diagnostics),
    issues: cleanIssues(source.issues),
  };
};

export const createUnknownDashboardCardStatuses = () => Object.fromEntries(
  DASHBOARD_CARD_DEFINITIONS.map((definition) => [
    definition.id,
    normalizeDashboardCardStatus({ status: 'loading' }, definition),
  ]),
);

export const normalizeDashboardCardStatuses = (value) => {
  const source = Array.isArray(value)
    ? Object.fromEntries(value.filter(Boolean).map((item) => [item.id, item]))
    : (value && typeof value === 'object' ? value : {});
  return Object.fromEntries(
    DASHBOARD_CARD_DEFINITIONS.map((definition) => [
      definition.id,
      normalizeDashboardCardStatus(source[definition.id], definition),
    ]),
  );
};

const sameList = (left = [], right = [], equal = (a, b) => a === b) => (
  left.length === right.length && left.every((value, index) => equal(value, right[index]))
);

const sameDiagnostic = (left, right) => (
  left?.label === right?.label && left?.value === right?.value
);

export const dashboardCardStatusEqual = (left, right) => (
  left?.id === right?.id
  && left?.status === right?.status
  && left?.statusLabel === right?.statusLabel
  && left?.detail === right?.detail
  && left?.sourceDate === right?.sourceDate
  && left?.date === right?.date
  && left?.summary === right?.summary
  && sameList(left?.diagnostics || [], right?.diagnostics || [], sameDiagnostic)
  && sameList(left?.issues || [], right?.issues || [])
);

export const mergeDashboardCardStatuses = (current, updates) => {
  const next = normalizeDashboardCardStatuses(current);
  const incoming = Array.isArray(updates) ? updates : [updates];

  incoming.filter(Boolean).forEach((update) => {
    const definition = DASHBOARD_CARD_DEFINITIONS.find(({ id }) => id === update.id);
    if (!definition) return;
    const normalized = normalizeDashboardCardStatus(update, definition);
    if (!dashboardCardStatusEqual(next[definition.id], normalized)) {
      next[definition.id] = normalized;
    }
  });

  const currentNormalized = normalizeDashboardCardStatuses(current);
  const changed = DASHBOARD_CARD_DEFINITIONS.some(({ id }) => (
    !dashboardCardStatusEqual(currentNormalized[id], next[id])
  ));
  return changed ? next : current;
};
