import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Loader, Upload, X } from 'lucide-react';
import { useSurfaceActivity } from '../common/PersistentSurface';
import AnalystSemanticText from './AnalystSemanticText';
import { formatAnalystReportDate, presentAnalystReportDates } from '../../utils/analystReportDates';
import { analystApi, stageAnalystPdf, validateAnalystPdf } from '../../services/analyst/analystClient';
import {
  analystSourceRefreshDelay,
  loadAnalystSourceReadiness,
  normalizeAnalystSourceReadiness,
} from '../../services/analyst/analystSourceReadiness';
import './AnalystSourceLibrary.css';

const SOURCE_SECTIONS = ['manual', 'automated'];

export default function AnalystSourceLibrary({ onClose }) {
  const active = useSurfaceActivity();
  const [section, setSection] = useState('manual');
  const [imports, setImports] = useState([]);
  const [importStatus, setImportStatus] = useState('loading');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [readiness, setReadiness] = useState(null);
  const [loadingSources, setLoadingSources] = useState(false);
  const fileRef = useRef(null);
  const manualRequestRef = useRef(0);
  const tabsRef = useRef({});

  const refreshImports = useCallback(async () => {
    const request = ++manualRequestRef.current;
    setImportStatus('loading');
    try {
      const result = await analystApi.imports();
      if (request === manualRequestRef.current) {
        setImports(result.imports || []);
        setImportStatus('ready');
      }
    } catch (nextError) {
      if (request === manualRequestRef.current) setImportStatus('unavailable');
      throw nextError;
    }
  }, []);

  useEffect(() => {
    if (!active || section !== 'manual') return undefined;
    refreshImports().catch(() => setError('Recent imports are unavailable.'));
    return () => { manualRequestRef.current += 1; };
  }, [active, refreshImports, section]);

  useEffect(() => {
    setReadiness(null);
    if (!active || section !== 'automated') return undefined;
    let stopped = false;
    let timer;
    let request = 0;
    const refresh = async () => {
      const currentRequest = ++request;
      window.clearTimeout(timer);
      setReadiness(null);
      if (document.hidden) return;
      setLoadingSources(true);
      // Schedule before awaiting the request so midnight also invalidates an
      // in-flight response from the preceding publication day.
      timer = window.setTimeout(refresh, analystSourceRefreshDelay());
      try {
        const result = await loadAnalystSourceReadiness();
        if (!stopped && currentRequest === request) {
          setReadiness(result);
          const normalized = normalizeAnalystSourceReadiness(result);
          if (normalized.available) {
            window.clearTimeout(timer);
            timer = window.setTimeout(refresh, analystSourceRefreshDelay(Date.now(), normalized.checkedAt));
          }
        }
      } catch {
        if (!stopped && currentRequest === request) setReadiness(null);
      } finally {
        if (!stopped && currentRequest === request) setLoadingSources(false);
      }
    };
    refresh();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      stopped = true;
      request += 1;
      window.clearTimeout(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [active, section]);

  const upload = useCallback(async (file) => {
    setError('');
    setNote('');
    setBusy('Validating');
    try {
      await validateAnalystPdf(file);
      const result = await stageAnalystPdf(file, (status) => setBusy(`${status[0].toUpperCase()}${status.slice(1)}`));
      setNote(result.status === 'duplicate' ? 'This exact PDF is already indexed.' : `Indexed for ${result.publicationDate ? formatAnalystReportDate(result.publicationDate) : 'the source library'}.`);
      await refreshImports();
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setBusy('');
      if (fileRef.current) fileRef.current.value = '';
    }
  }, [refreshImports]);

  const sources = normalizeAnalystSourceReadiness(readiness);
  const moveTabFocus = (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = SOURCE_SECTIONS.indexOf(section);
    const next = event.key === 'Home' ? SOURCE_SECTIONS[0]
      : event.key === 'End' ? SOURCE_SECTIONS[SOURCE_SECTIONS.length - 1]
        : SOURCE_SECTIONS[(index + (event.key === 'ArrowRight' ? 1 : -1) + SOURCE_SECTIONS.length) % SOURCE_SECTIONS.length];
    setSection(next);
    tabsRef.current[next]?.focus();
  };

  return (
    <aside className="analyst-drawer analyst-source-library is-open" data-testid="analyst-source-library" aria-label="Source Library">
      <header>
        <h2>Source Library</h2>
        <button type="button" className="analyst-icon-button" aria-label="Close source library" onClick={onClose}><X size={16} /></button>
      </header>
      <div className="analyst-source-tabs" role="tablist" aria-label="Source sections">
        {SOURCE_SECTIONS.map((tab) => (
          <button key={tab} ref={(element) => { tabsRef.current[tab] = element; }} type="button" role="tab" id={`analyst-source-tab-${tab}`} aria-selected={section === tab} aria-controls={`analyst-source-panel-${tab}`} tabIndex={section === tab ? 0 : -1} onKeyDown={moveTabFocus} onClick={() => setSection(tab)}>
            {tab === 'manual' ? 'Manual' : 'Automated'}
          </button>
        ))}
      </div>
      <div className="analyst-source-body" role="tabpanel" id={`analyst-source-panel-${section}`} aria-labelledby={`analyst-source-tab-${section}`} tabIndex={0}>
        {section === 'manual' ? (
          <>
            <button type="button" className="analyst-source-upload" disabled={Boolean(busy)} onClick={() => fileRef.current?.click()}>
              {busy ? <Loader className="analyst-spin" size={16} /> : <Upload size={16} />}
              <span>{busy ? `${busy}…` : 'Upload & index a PDF'}</span>
              <small>PDF only · 50 MB max</small>
            </button>
            <input ref={fileRef} data-testid="analyst-pdf-input" type="file" accept="application/pdf,.pdf" hidden onChange={(event) => event.target.files?.[0] && upload(event.target.files[0])} />
            {error && <div className="analyst-source-error" role="alert">{error}</div>}
            {note && <div className="analyst-source-note" role="status"><AnalystSemanticText>{note}</AnalystSemanticText></div>}
            <section className="analyst-source-imports">
              <h3>Recent imports</h3>
              {!imports.length && importStatus === 'ready' && <p>No manual PDFs yet.</p>}
              {imports.map((job) => (
                <article key={job.import_id}>
                  <div><span>{job.filename}</span><span>{String(job.status || '').replaceAll('_', ' ')}</span></div>
                  {job.failure_reason && <p className="analyst-source-error">{job.failure_reason}</p>}
                </article>
              ))}
            </section>
          </>
        ) : (
          <section className="analyst-source-automated" aria-busy={loadingSources}>
            <p className="analyst-source-date analyst-process--key">{formatAnalystReportDate(sources.date)}</p>
            <table>
              <thead><tr><th scope="col">Product</th><th scope="col">Updated</th><th scope="col">Usable today</th></tr></thead>
              <tbody>
                {sources.rows.map((row) => (
                  <tr key={row.id}>
                    <td>{row.label}</td>
                    <td>{row.updatedAt ? <time className="analyst-process--key" dateTime={row.updatedAt} title={`${formatAnalystReportDate(row.updatedAt)} · Publication ${formatAnalystReportDate(row.publicationDate)}`}>{formatAnalystReportDate(row.updatedAt, { year: false })}</time> : '—'}</td>
                    <td className={row.usableForDay ? 'is-usable' : 'is-unavailable'} title={presentAnalystReportDates(row.reason) || undefined}>{row.usableForDay ? 'Ready' : 'Unavailable'}</td>
                  </tr>
                ))}
                {!sources.rows.length && <tr><td colSpan={3} className="analyst-source-empty">{loadingSources ? 'Checking sources…' : 'UNAVAILABLE'}</td></tr>}
              </tbody>
            </table>
          </section>
        )}
      </div>
    </aside>
  );
}
