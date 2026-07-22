import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { MarketDataService } from '../../services/api/marketDataService';
import { useTheme } from '../../context/ThemeContext';
import { getIbkrPortfolioStatusDot } from '../../utils/ibkrConnectionStatus';
import { startVisibilityAwarePolling } from '../../utils/visibilityAwarePolling';
import LoadingIndicator from '../common/LoadingIndicator';
import './AnalyticsDailyBrief.css';

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || 'http://localhost:3001';
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

const EVENT_PRIORITY = {
  action_signal: 0,
  trend_change: 1,
  added_long: 2,
  added_short: 2,
  closed_long: 3,
  closed_short: 3,
  added: 4,
  removed: 4,
  rank_change: 5,
};

const STATUS_LABELS = {
  current: 'Current',
  not_due: 'Not due',
  late: 'Late',
  missing: 'Missing',
  error: 'Error',
  quality_warning: 'Quality warning',
};

const TRUST_LABELS = {
  trusted: 'Verified',
  degraded: 'Degraded',
  unavailable: 'Unavailable',
};

function formatDate(value) {
  if (!value) return '—';
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const date = match
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12)
    : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return formatDate(value);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function holdingSymbol(holding) {
  return String(
    holding?.symbol || holding?.ticker || holding?.contract?.symbol || '',
  ).trim().toUpperCase();
}

function holdingSide(holding) {
  const signedPosition = Number(
    holding?.position ?? holding?.quantity ?? holding?.shares ?? holding?.marketValue,
  );
  const explicit = String(holding?.side || holding?.type || '').toUpperCase();
  if (explicit.includes('SHORT') || (Number.isFinite(signedPosition) && signedPosition < 0)) return 'short';
  return 'long';
}

function relationForGroup(side, events) {
  const directions = new Set(events.map((event) => event.direction).filter(Boolean));
  if ((side === 'long' && directions.has('bearish')) || (side === 'short' && directions.has('bullish'))) {
    return 'conflict';
  }
  if ((side === 'long' && directions.has('bullish')) || (side === 'short' && directions.has('bearish'))) {
    return 'aligned';
  }
  return 'affected';
}

const PREVIEW_FIELD_PRIORITY = [
  'action',
  'call',
  'direction',
  'trend',
  'description',
  'message',
  'etf',
  'assetClass',
  'rank',
  'previousRank',
  'newRank',
  'value',
  'dateAdded',
];

function humanizeKey(value) {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/^./, (letter) => letter.toUpperCase());
}

function compactValue(value) {
  if (value == null) return '—';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    const primitives = value.filter((item) => ['string', 'number', 'boolean'].includes(typeof item));
    if (primitives.length === value.length) return primitives.slice(0, 6).join(' · ');
    return `${value.length} structured record${value.length === 1 ? '' : 's'}`;
  }

  const identifiers = new Set(['id', 'ticker', 'symbol']);
  const fields = Object.entries(value)
    .filter(([key, fieldValue]) => !identifiers.has(key) && (
      fieldValue == null || ['string', 'number', 'boolean'].includes(typeof fieldValue)
    ))
    .sort(([left], [right]) => {
      const leftPriority = PREVIEW_FIELD_PRIORITY.indexOf(left);
      const rightPriority = PREVIEW_FIELD_PRIORITY.indexOf(right);
      return (leftPriority === -1 ? 99 : leftPriority) - (rightPriority === -1 ? 99 : rightPriority);
    })
    .slice(0, 4);

  if (fields.length === 0) return 'Structured record · open Developer JSON for details';
  return fields.map(([key, fieldValue]) => `${humanizeKey(key)}: ${fieldValue ?? '—'}`).join(' · ');
}

function previewEntries(parsed) {
  if (!parsed || typeof parsed !== 'object') return [];
  if (Array.isArray(parsed.rows)) {
    return parsed.rows.slice(0, 20).map((row, index) => ({
      key: row?.ticker || row?.symbol || `Row ${index + 1}`,
      value: row,
    }));
  }
  const data = parsed.data ?? parsed;
  if (Array.isArray(data)) {
    return data.slice(0, 20).map((row, index) => ({
      key: row?.ticker || row?.symbol || row?.metric || `Row ${index + 1}`,
      value: row,
    }));
  }
  if (data && typeof data === 'object') {
    return Object.entries(data).slice(0, 20).map(([key, value]) => ({ key, value }));
  }
  return [{ key: 'Value', value: data }];
}

function SourceInspector({ selection, onClose }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showJson, setShowJson] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError('');
    setShowJson(false);
    setLoading(true);
    axios.get(
      `${BACKEND_URL}/api/analytics/sources/${encodeURIComponent(selection.sourceId)}/snapshots/${encodeURIComponent(selection.snapshotId)}`,
    ).then((response) => {
      if (!cancelled) setDetail(response.data);
    }).catch((requestError) => {
      if (!cancelled) {
        setError(requestError?.response?.data?.error || requestError.message || 'Unable to load source snapshot.');
      }
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [selection.snapshotId, selection.sourceId]);

  const entries = useMemo(() => previewEntries(detail?.parsed), [detail?.parsed]);

  return (
    <div className="adb-inspector" role="dialog" aria-modal="true" aria-label="Source inspector">
      <div className="adb-inspector__header">
        <div>
          <span className="adb-eyebrow">Source inspector</span>
          <h2>{selection.label}</h2>
        </div>
        <button type="button" className="adb-icon-button" onClick={onClose} aria-label="Close source inspector">×</button>
      </div>

      {loading ? (
        <LoadingIndicator label="Loading source snapshot…" size="sm" centered />
      ) : error ? (
        <div className="adb-state adb-state--error">{error}</div>
      ) : (
        <div className="adb-inspector__body">
          <div className="adb-inspector__meta">
            <div><span>Content date</span><strong>{formatDate(detail?.contentDate)}</strong></div>
            <div><span>Published</span><strong>{formatDateTime(detail?.publishedAt)}</strong></div>
            <div><span>Ingested</span><strong>{formatDateTime(detail?.ingestedAt)}</strong></div>
            <div><span>Source</span><strong>{detail?.source || '—'}</strong></div>
          </div>

          {Array.isArray(detail?.quality?.warnings) && detail.quality.warnings.length > 0 && (
            <div className="adb-state adb-state--warning">{detail.quality.warnings.join(' · ')}</div>
          )}

          <div className="adb-inspector__actions">
            {detail?.artifactUrl && (
              <a href={`${BACKEND_URL}${detail.artifactUrl}`} target="_blank" rel="noreferrer">Open original artifact</a>
            )}
            <button type="button" className="adb-text-button" onClick={() => setShowJson((value) => !value)}>
              {showJson ? 'Hide developer JSON' : 'Developer JSON'}
            </button>
          </div>

          {showJson ? (
            <pre className="adb-json">{JSON.stringify(detail?.parsed, null, 2)}</pre>
          ) : entries.length > 0 ? (
            <div className="adb-preview-table" role="table" aria-label="Parsed source preview">
              {entries.map((entry, index) => (
                <div className="adb-preview-row" role="row" key={`${entry.key}-${index}`}>
                  <strong role="cell">{entry.key}</strong>
                  <span role="cell">{compactValue(entry.value)}</span>
                </div>
              ))}
              {entries.length === 20 && <div className="adb-preview-more">Showing the first 20 parsed rows.</div>}
            </div>
          ) : (
            <div className="adb-state">No parsed rows are available for this snapshot.</div>
          )}
        </div>
      )}
    </div>
  );
}

function dedupeHermesAlerts(alerts) {
  const groups = new Map();
  for (const alert of Array.isArray(alerts) ? alerts : []) {
    const fingerprint = [alert?.title, alert?.category, alert?.message, alert?.recommendedAction].filter(Boolean).join('|');
    const key = fingerprint || alert?.alertId || alert?.id || 'unknown-alert';
    const existing = groups.get(key);
    const timestamp = alert?.updatedAt || alert?.createdAt || alert?.timestamp || null;
    if (!existing) {
      groups.set(key, { ...alert, occurrences: 1, firstSeen: timestamp, lastSeen: timestamp });
    } else {
      existing.occurrences += 1;
      if (timestamp && (!existing.lastSeen || timestamp > existing.lastSeen)) {
        existing.lastSeen = timestamp;
        existing.alertId = alert.alertId || alert.id || existing.alertId;
        existing.id = alert.id || existing.id;
      }
      if (timestamp && (!existing.firstSeen || timestamp < existing.firstSeen)) existing.firstSeen = timestamp;
    }
  }
  return [...groups.values()].sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')));
}

function OperationsView({ onBack }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await MarketDataService.getHermesDirectorStatus());
    } catch (loadError) {
      setData(null);
      setError(loadError.message || 'Unable to load operations.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const runCommand = async (command) => {
    setBusy(command);
    setMessage('');
    try {
      const result = await MarketDataService.runHermesDirectorCommand(command);
      if (result?.snapshot) setData(result.snapshot);
      setMessage(result?.message || `${command} completed.`);
    } catch (commandError) {
      setMessage(commandError.message || `Failed to run ${command}.`);
    } finally {
      setBusy('');
    }
  };

  const alerts = dedupeHermesAlerts(data?.alerts);
  const workers = Array.isArray(data?.workers) ? data.workers : [];

  return (
    <div className="adb-operations">
      <div className="adb-section-header">
        <div>
          <span className="adb-eyebrow">Separate control plane</span>
          <h2>Operations</h2>
        </div>
        <button type="button" className="adb-text-button" onClick={onBack}>Back to analytics</button>
      </div>

      {loading ? <LoadingIndicator label="Loading operations…" size="sm" centered /> : error ? (
        <div className="adb-state adb-state--error">{error}</div>
      ) : (
        <>
          <div className="adb-ops-summary">
            <div><span>Status</span><strong>{data?.director?.status || 'Unknown'}</strong></div>
            <div><span>Open alerts</span><strong>{alerts.length}</strong></div>
            <div><span>Last event</span><strong>{formatDateTime(data?.director?.lastUpdated)}</strong></div>
          </div>

          <div className="adb-command-bar">
            {['status', 'run analyst now', 'run dev now', 'run security now', 'summarize today', 'what changed'].map((command) => (
              <button type="button" key={command} disabled={Boolean(busy)} onClick={() => runCommand(command)}>
                {busy === command ? 'Running…' : command}
              </button>
            ))}
          </div>
          {message && <div className="adb-state">{message}</div>}

          <section className="adb-ops-section">
            <h3>Worker health</h3>
            <div className="adb-worker-grid">
              {workers.map((worker) => (
                <article key={worker.id || worker.name}>
                  <div><strong>{worker.name || worker.label}</strong><span className={`adb-status adb-status--${worker.status || 'unknown'}`}>{worker.status || 'unknown'}</span></div>
                  <p>{worker.latestSummary || worker.summary || 'No verified run summary.'}</p>
                  <time>{formatDateTime(worker.lastRunAt || worker.lastRun)}</time>
                </article>
              ))}
            </div>
          </section>

          <section className="adb-ops-section">
            <h3>Current alert groups</h3>
            {alerts.length === 0 ? <div className="adb-state">No current Hermes alerts.</div> : alerts.slice(0, 12).map((alert) => (
              <article className="adb-ops-alert" key={`${alert.title || alert.category}-${alert.firstSeen}`}>
                <div>
                  <strong>{alert.title || alert.category || 'Operations alert'}</strong>
                  <span>{alert.occurrences} occurrence{alert.occurrences === 1 ? '' : 's'}</span>
                </div>
                <p>{alert.message || alert.summary || 'No detail supplied.'}</p>
                <time>First {formatDateTime(alert.firstSeen)} · Last {formatDateTime(alert.lastSeen)}</time>
              </article>
            ))}
          </section>
        </>
      )}
    </div>
  );
}

const WorkflowStatus = ({ portfolioData = null, connection = null, forceRefresh = false }) => {
  const { theme } = useTheme();
  const [brief, setBrief] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState(null);
  const [selection, setSelection] = useState(null);
  const [showOperations, setShowOperations] = useState(false);
  const forceRefreshRef = useRef(forceRefresh);

  const fetchBrief = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const refresh = forceRefreshRef.current;
      forceRefreshRef.current = false;
      const response = await axios.get(
        `${BACKEND_URL}/api/analytics/daily-brief${refresh ? '?refresh=1' : ''}`,
      );
      const cacheState = response.headers?.['x-data-cache'] || response.data?.cacheState;
      if (cacheState === 'stale' && Array.isArray(response.data?.events) && response.data.events.length > 0) {
        throw new Error('Stale analytics response contained actionable events.');
      }
      setBrief(response.data);
      setLastUpdated(new Date());
    } catch (requestError) {
      setBrief(null);
      setError(requestError?.response?.data?.error || requestError.message || 'Unable to load verified analytics.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => startVisibilityAwarePolling({
    poll: fetchBrief,
    intervalMs: REFRESH_INTERVAL_MS,
    pollOnStart: true,
  }), [fetchBrief]);

  const portfolioStatus = useMemo(() => getIbkrPortfolioStatusDot({
    connection,
    portfolioData,
    loading: false,
  }), [connection, portfolioData]);
  const portfolioMatchingAvailable = portfolioStatus.status === 'active';

  const liveHoldings = useMemo(() => {
    if (!portfolioMatchingAvailable) return new Map();
    return new Map((Array.isArray(portfolioData?.holdings) ? portfolioData.holdings : [])
      .map((holding) => [holdingSymbol(holding), { holding, side: holdingSide(holding) }])
      .filter(([symbol]) => Boolean(symbol)));
  }, [portfolioData?.holdings, portfolioMatchingAvailable]);

  const groups = useMemo(() => {
    const grouped = new Map();
    for (const event of Array.isArray(brief?.events) ? brief.events : []) {
      if (!grouped.has(event.ticker)) grouped.set(event.ticker, { ticker: event.ticker, events: [] });
      grouped.get(event.ticker).events.push(event);
    }
    return [...grouped.values()].map((group) => {
      group.events.sort((a, b) => (EVENT_PRIORITY[a.kind] ?? 99) - (EVENT_PRIORITY[b.kind] ?? 99));
      const liveMatch = liveHoldings.get(group.ticker) || null;
      return {
        ...group,
        liveMatch,
        relation: liveMatch ? relationForGroup(liveMatch.side, group.events) : null,
        priority: liveMatch ? 0 : Math.min(...group.events.map((event) => EVENT_PRIORITY[event.kind] ?? 99)),
      };
    }).sort((a, b) => a.priority - b.priority || a.ticker.localeCompare(b.ticker));
  }, [brief?.events, liveHoldings]);

  if (showOperations) return <OperationsView onBack={() => setShowOperations(false)} />;

  return (
    <div className={`adb-shell ${theme === 'dark' ? 'adb-shell--dark' : ''}`}>
      <div className="adb-brief-header">
        <div>
          <span className="adb-eyebrow">Daily decision brief</span>
          <h1>Today’s verified changes</h1>
          <p>Source-attributed research changes, not dashboard trade recommendations.</p>
        </div>
        {brief?.trust && (
          <span className={`adb-trust adb-trust--${brief.trust.status}`} title={brief.trust.reason}>
            {TRUST_LABELS[brief.trust.status] || brief.trust.status}
          </span>
        )}
      </div>

      {loading && !brief ? (
        <LoadingIndicator label="Loading verified changes…" size="sm" centered />
      ) : error ? (
        <div className="adb-state adb-state--error">
          <strong>Verified analytics unavailable</strong>
          <span>{error}</span>
        </div>
      ) : brief ? (
        <>
          <div className="adb-trust-strip">
            <div>
              <span>Research</span>
              <strong>{brief.trust?.reason || '—'}</strong>
            </div>
            <div>
              <span>Portfolio matching</span>
              <strong className={portfolioMatchingAvailable ? 'is-current' : 'is-unavailable'}>
                {portfolioMatchingAvailable ? 'Verified live IBKR' : 'Unavailable'}
              </strong>
            </div>
            <div>
              <span>Refreshed</span>
              <strong>{formatDateTime(lastUpdated)}</strong>
            </div>
          </div>

          {!portfolioMatchingAvailable && (
            <div className="adb-state adb-state--muted">
              Portfolio matching is hidden until IBKR portfolio data is connected, current, and complete.
            </div>
          )}

          {Array.isArray(brief.issues) && brief.issues.length > 0 && (
            <section className="adb-section adb-section--issues">
              <div className="adb-section-header">
                <div><span className="adb-eyebrow">Exceptions only</span><h2>Needs attention</h2></div>
                <span>{brief.issues.length}</span>
              </div>
              <div className="adb-issue-list">
                {brief.issues.map((issue) => (
                  <button
                    type="button"
                    key={`${issue.sourceId}-${issue.status}`}
                    disabled={!issue.snapshotId || issue.sourceId === 'analytics-cache'}
                    onClick={() => setSelection({ sourceId: issue.sourceId, snapshotId: issue.snapshotId, label: issue.label })}
                  >
                    <span className={`adb-status adb-status--${issue.status}`}>{STATUS_LABELS[issue.status] || issue.status}</span>
                    <strong>{issue.label}</strong>
                    <span>{issue.reason}</span>
                    <time>{formatDate(issue.contentDate)}</time>
                  </button>
                ))}
              </div>
            </section>
          )}

          <section className="adb-section">
            <div className="adb-section-header">
              <div><span className="adb-eyebrow">Material deltas</span><h2>Changes that matter</h2></div>
              <span>{groups.length}</span>
            </div>
            {groups.length === 0 ? (
              <div className="adb-state adb-state--clean">No verified changes today.</div>
            ) : (
              <div className="adb-event-list">
                {groups.map((group) => (
                  <article className={`adb-event-group ${group.liveMatch ? 'adb-event-group--held' : ''}`} key={group.ticker}>
                    <div className="adb-event-group__head">
                      <strong>{group.ticker}</strong>
                      {group.liveMatch && (
                        <span className={`adb-holding adb-holding--${group.relation}`}>
                          Held {group.liveMatch.side} · {group.relation}
                        </span>
                      )}
                    </div>
                    <div className="adb-event-group__body">
                      {group.events.map((event) => (
                        <button
                          type="button"
                          key={event.id}
                          onClick={() => setSelection({
                            sourceId: event.sourceId,
                            snapshotId: event.snapshotId,
                            label: event.sourceLabel,
                          })}
                        >
                          <span className={`adb-direction adb-direction--${event.direction || 'none'}`}>{event.direction || 'update'}</span>
                          <span className="adb-event-description">{event.description}</span>
                          <span className="adb-event-source">{event.sourceLabel}</span>
                          <time>{formatDateTime(event.eventAt)}</time>
                        </button>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          <details className="adb-health">
            <summary>
              <span>Data health</span>
              <strong>{brief.summary?.current || 0} current · {brief.summary?.issues || 0} issues</strong>
            </summary>
            <div className="adb-health__rows">
              {(brief.sourceHealth || []).map((source) => (
                <button
                  type="button"
                  key={source.sourceId}
                  disabled={!source.snapshotId}
                  onClick={() => setSelection({ sourceId: source.sourceId, snapshotId: source.snapshotId, label: source.label })}
                >
                  <strong>{source.label}</strong>
                  <span className={`adb-status adb-status--${source.status}`}>{STATUS_LABELS[source.status] || source.status}</span>
                  <time>{formatDate(source.contentDate)}</time>
                </button>
              ))}
            </div>
          </details>

          <div className="adb-footer">
            <span>Research snapshots are dated references; no prices or executions are inferred here.</span>
            <button type="button" className="adb-text-button" onClick={() => setShowOperations(true)}>Open operations</button>
          </div>
        </>
      ) : null}

      {selection && <SourceInspector selection={selection} onClose={() => setSelection(null)} />}
    </div>
  );
};

export default WorkflowStatus;
