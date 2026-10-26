import React, { useEffect, useState } from 'react';
import { analystWorkspaceApi as api } from '../../services/analyst/analystClient';
import AnalystAlertThread from './AnalystAlertThread';
import { describeAnalystFinding } from '../../utils/analystFindingPresentation.cjs';
import { activeAttentionFinding, attentionEvidenceFreshness, attentionPriority, isActionRequired, isAttentionFinding } from '../../utils/analystInboxAlerts.cjs';
import './AnalystInbox.css';

const DURATIONS = ['Tick', 'Trade', 'Trend', 'Tail'];
const HORIZONS = ['1D', '15D', '30D', '90D'];
const BIAS_TONES = { Bullish: 'positive', Bearish: 'negative', Neutral: 'neutral' };
const DIRECTION_TONES = { long: 'positive', longs: 'positive', bullish: 'positive', short: 'negative', shorts: 'negative', bearish: 'negative', neutral: 'neutral' };

function DirectionalText({ children }) {
  const parts = String(children || '').split(/(\b(?:longs?|shorts?|bullish|bearish|neutral|quad\s+[1-4])\b)/gi);
  return parts.map((part, index) => {
    const quad = part.match(/^quad\s+([1-4])$/i);
    if (quad) return <span key={index} className={`analyst-inbox-quad--${quad[1]}`}>{part}</span>;
    const tone = DIRECTION_TONES[part.toLowerCase()];
    // Time horizons do not describe a position's direction.
    const timeHorizon = /^(?:long|short)$/i.test(part) && /^[ -](?:term|run|duration|dated)\b/i.test(parts[index + 1] || '');
    return tone && !timeHorizon
      ? <span key={index} className={`analyst-inbox-signal--${tone}`}>{part}</span>
      : part;
  });
}

// "Oct 23 09:41" in the viewer's local time. A midnight-UTC stamp stands in for a
// date-only publication, so it shows the date alone.
function publicationLabel(time, date) {
  const at = new Date(time);
  if (time && Number.isFinite(at.getTime()) && !/T00:00:00(?:\.0+)?Z$/.test(time)) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(at).map(part => [part.type, part.value]));
    return `${parts.month} ${parts.day} ${parts.hour}:${parts.minute}`;
  }
  const day = new Date(`${String(date || time || '').slice(0, 10)}T12:00:00Z`);
  if (!Number.isFinite(day.getTime())) return null;
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(day);
}

// Security alerts lead with their ticker; operational subjects are not tickers.
const TICKER_KINDS = new Set(['portfolio', 'opportunity']);

// Without a verified weight, the verified share count still sizes the position.
const heldShares = (side, quantity) => ['Long', 'Short'].includes(side) && Number.isFinite(quantity) && quantity
  ? `${side} ${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Math.abs(quantity))} sh` : side;

// An urgent instruction remains visible during a holdings outage; say which
// verification it rests on instead of presenting the position as current.
function staleHoldingLabel(payload) {
  const side = heldShares(payload.quantity > 0 ? 'Long' : payload.quantity < 0 ? 'Short' : 'Not held', payload.quantity);
  const at = new Date(payload.holdingsVerifiedAt);
  return Number.isFinite(at.getTime())
    ? `${side} (last verified ${new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(at)}; holdings currently unavailable)`
    : `${side} (holdings currently unavailable)`;
}

function attentionContent(finding, now) {
  if (!activeAttentionFinding(finding, now)) return null;
  const payload = finding.payload || finding;
  const presentation = payload.presentation || finding.presentation;
  const holding = describeAnalystFinding(finding, [], now);
  const freshHoldings = attentionEvidenceFreshness(finding, now).holdings;
  const rows = presentation.rows.filter(row => typeof row?.label === 'string' && typeof row.text === 'string'
    && row.label.trim() && row.text.trim() && (!row.requiresFreshHoldings || freshHoldings))
    .map(row => {
      if (row.label === 'Current position' && !freshHoldings && finding.holdingsStale) return { ...row, text: staleHoldingLabel(payload) };
      if (row.label === 'Current position') return { ...row, text: !freshHoldings ? 'Unavailable' : holding.currentPosition.label === 'Closed' ? 'Not held' : holding.currentPosition.label };
      if (row.label === 'Position size') return { ...row, text: freshHoldings && holding.currentHolding?.label || 'Unavailable' };
      return row;
    })
    // One line reads "Long @ 1.97%"; a size that is unavailable is left off.
    .reduce((merged, row) => {
      const index = merged.findIndex(item => item.label === 'Current position');
      if (row.label !== 'Position size' || index < 0) return [...merged, row];
      const position = merged[index];
      if (row.text === 'Unavailable' || !['Long', 'Short'].includes(position.text)) return merged;
      return merged.map((item, i) => i === index ? { ...position, text: `${position.text} @ ${row.text}` } : item);
    }, [])
    .map(row => row.label === 'Current position' ? { ...row, text: heldShares(row.text, payload.quantity) } : row);
  if (!rows.length) return null;
  return { ...presentation, rows, publicationDate: presentation.date || payload.publicationTime,
    sortTime: Date.parse(payload.publicationTime) || Date.parse(presentation.date) || 0 };
}

const signed = (value, digits = 1) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(digits)}%`;
const toneClass = tone => tone ? `analyst-inbox-signal--${tone}` : undefined;

// Price windows are colored against the held side; volatility only when it runs
// well above its one-year level. Volume carries no direction of its own.
function horizonRows(stats, side) {
  const columns = stats?.columns || HORIZONS.map(label => ({ label }));
  const against = value => !side || value == null || value === 0 ? null : value * side > 0 ? 'positive' : 'negative';
  const cell = (value, format, tone) => value == null ? { text: '—', tone: 'muted' } : { text: format(value), tone };
  return [
    ['Price', columns.map(column => cell(column.priceChangePct, signed, against(column.priceChangePct)))],
    ['Realized vol', columns.map(column => cell(column.realizedVolPct, value => `${value}%`,
      stats?.baselineVolPct && column.realizedVolPct > stats.baselineVolPct * 1.25 ? 'negative' : null))],
    ['Volume / avg', columns.map(column => cell(column.volumeRatio, value => `${value.toFixed(1)}×`))],
    ['Range position', columns.map(column => cell(column.rangePct, value => `${value}%`,
      column.rangePct == null ? null : against(column.rangePct < 20 ? -1 : column.rangePct > 80 ? 1 : 0)))],
  ];
}

function HorizonTable({ durations, stats, side }) {
  return <table className="analyst-inbox-horizons">
    <colgroup><col className="analyst-inbox-horizons-label" />{HORIZONS.map(label => <col key={label} className="analyst-inbox-horizons-column" />)}</colgroup>
    <thead><tr><td />{durations.map(row => <th key={row.label} scope="col">{row.label}</th>)}</tr></thead>
    <tbody>
      <tr className="analyst-inbox-bias"><td />{durations.map(row => <td key={row.label}>
        <span className={`analyst-inbox-bias-cell is-${BIAS_TONES[row.text] || 'unavailable'}`}>{row.text}</span>
      </td>)}</tr>
      <tr className="analyst-inbox-horizon-head"><td />{(stats?.columns || HORIZONS.map(label => ({ label }))).map(column => <th key={column.label} scope="col">{column.label}</th>)}</tr>
      {horizonRows(stats, side).map(([label, cells]) => <tr key={label}>
        <th scope="row" title={label === 'Range position' ? 'Close between the window low (0%) and high (100%)' : undefined}>{label}</th>
        {cells.map((cell, index) => <td key={index} className={toneClass(cell.tone)}>{cell.text}</td>)}
      </tr>)}
    </tbody>
  </table>;
}

// The alert as the user reads it, so the Analyst discusses this exact card.
function alertSummary(finding, content, modern, date) {
  const payload = finding.payload || finding;
  const title = `${modern ? content.subject : finding.symbol || payload.symbol}${date ? ` (${date})` : ''}`;
  const lines = modern ? content.rows.map(row => `${row.label}: ${row.text}`) : [
    `Current position: ${content.currentPosition?.label || 'Unavailable'}`,
    `Action: ${content.positionAction || 'Unavailable'}`,
    content.headline && `${content.updateLabel || 'Signal'}: ${content.headline}`,
    ...[content.detail, ...(content.sourceContext || [])].filter(Boolean).map(text => `Context: ${text}`),
  ];
  return [title, ...lines.filter(Boolean)].join('\n').slice(0, 8_000);
}

export default function AnalystInbox({ findings = [], error = '', onCitation, onAcknowledge, loadHorizonStats, MessageComponent }) {
  // Alert id → its Analyst conversation; the server drops the link on dismiss.
  const [threads, setThreads] = useState({});
  const findingIds = findings.map(finding => finding.id).join(',');
  useEffect(() => {
    let current = true;
    // A failed lookup only hides existing threads; it never blocks the Inbox.
    Promise.resolve().then(() => api.request('/inbox-threads'))
      // Merge, so a thread started while this request was in flight survives it.
      .then(result => current && setThreads(previous => ({ ...previous, ...(result?.threads || {}) })), () => {});
    return () => { current = false; };
  }, [findingIds]);
  const [now, setNow] = useState(Date.now);
  const [horizonStats, setHorizonStats] = useState({});
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);
  const alerts = findings.filter(finding => finding.unread !== 0 && finding.unread !== false)
    .map(finding => ({ finding, modern: isAttentionFinding(finding),
      content: isAttentionFinding(finding) ? attentionContent(finding, now) : describeAnalystFinding(finding, findings, now) }))
    .filter(({ finding, content }) => content && content.positionAction !== 'Neutral — no change'
      && !['resolved', 'unavailable'].includes(finding.state || finding.payload?.state))
    .sort((a, b) => attentionPriority(a.finding) - attentionPriority(b.finding)
      || (b.content.sortTime || Date.parse(b.content.publicationDate) || 0) - (a.content.sortTime || Date.parse(a.content.publicationDate) || 0));
  const securities = [...new Set(alerts.filter(({ modern, content }) => modern && content.rows.some(row => DURATIONS.includes(row.label)))
    .map(({ content }) => content.subject))].sort().join(',');
  useEffect(() => {
    if (!loadHorizonStats || !securities) return undefined;
    let current = true;
    loadHorizonStats(securities.split(',')).then(rows => current && setHorizonStats(previous => ({ ...previous, ...rows })), () => {});
    return () => { current = false; };
  }, [loadHorizonStats, securities]);
  const urgent = alerts.filter(({ finding }) => isActionRequired(finding));
  const ordinary = alerts.filter(({ finding }) => !isActionRequired(finding));

  return <section className="analyst-inbox" aria-label="Portfolio inbox">
    {error && <p className="analyst-inbox-error" role="alert">{error}</p>}
    {!alerts.length && <p className="analyst-inbox-empty">No new items requiring attention.</p>}
    {urgent.length > 0 && <h2 className="analyst-inbox-urgent-heading">Alerts</h2>}
    {[...urgent, ...ordinary].map(({ finding, content, modern }, index) => {
      const payload = finding.payload || finding;
      const date = publicationLabel(payload.publicationTime, content.publicationDate);
      const subject = modern ? content.subject : finding.symbol || payload.symbol;
      const ticker = modern ? TICKER_KINDS.has(payload.kind) && subject : subject;
      // Centered in the footer between Source and Dismiss.
      const stamp = date && <time className="analyst-inbox-time" dateTime={payload.publicationTime || content.publicationDate}>{date}</time>;
      const updateParts = content.updateParts || [{ text: content.headline, tone: content.tone }];
      const contextLines = [content.detail, ...(content.sourceContext || [])].filter(Boolean);
      const required = isActionRequired(finding);
      // Every linked publication opens from one Source popover beside the button.
      const durations = modern ? DURATIONS.map(label => content.rows.find(row => row.label === label)).filter(Boolean) : [];
      const rows = modern ? content.rows.filter(row => !DURATIONS.includes(row.label)) : [];
      const side = Math.sign(Number(payload.quantity) || 0) || null;
      const citations = content.sourceLinks?.length ? content.sourceLinks.filter(link => link?.citation && link.label).map(link => link.citation)
        : payload.citation ? [payload.citation] : [];
      return <React.Fragment key={finding.id}>
      {!required && index === urgent.length && urgent.length > 0 && <h2 className="analyst-inbox-ordinary-heading">Notifications</h2>}
      <article className={`analyst-inbox-finding${finding.unread ? ' is-unread' : ''}${required ? ' is-action-required' : ''}`}>
        <h3 className="sr-only">{subject}</h3>
        <div className={durations.length ? 'analyst-inbox-body has-horizons' : 'analyst-inbox-body'}>
        <dl className="analyst-inbox-copy">
          {ticker && <div className="analyst-inbox-ticker">
            <dt>Ticker: </dt><dd>{ticker}</dd>
          </div>}
          {modern ? rows.map((row, index) => <div key={`${row.label}-${index}`}>
            <dt>{row.label}: </dt><dd className={['Unavailable', 'N/A'].includes(row.text) ? 'analyst-inbox-signal--neutral' : undefined}><DirectionalText>{row.text}</DirectionalText></dd>
          </div>) : <>
          <div className="analyst-inbox-position">
            <dt>Current position: </dt><dd><DirectionalText>{content.currentPosition.label}</DirectionalText>
              {content.currentHolding?.label && ['Long', 'Short'].includes(content.currentPosition.label) && ` @ ${content.currentHolding.label}`}</dd>
          </div>
          <div className="analyst-inbox-action">
            <dt>Action: </dt><dd className={content.positionAction === 'Unavailable' ? 'analyst-inbox-signal--neutral' : undefined}><DirectionalText>{content.updateLabel === 'Action' && content.positionAction !== 'Unavailable'
              ? `${content.headline} — ${content.positionAction.toLowerCase()}` : content.positionAction}</DirectionalText></dd>
          </div>
          {content.updateLabel !== 'Action' && <div className="analyst-inbox-update">
            <dt>{content.updateLabel || 'Signal'}: </dt>
            <dd>{updateParts.map((part, index) => (
              <span key={index} className={`analyst-inbox-signal--${['positive', 'negative'].includes(part.tone) ? part.tone : 'neutral'}`}><DirectionalText>{part.text}</DirectionalText></span>
            ))}</dd>
          </div>}
          {content.proxyAttribution && <div className="analyst-inbox-proxy">
            <dt>Underlying: </dt>
            <dd><strong>{content.proxyAttribution.sourceName
              ? `${content.proxyAttribution.sourceName} (${content.proxyAttribution.sourceSymbol})`
              : content.proxyAttribution.sourceSymbol}</strong>
            {' — tracked by '}{content.proxyAttribution.holdingSymbol}.</dd>
          </div>}
          {content.changeSummary && <div className="analyst-inbox-change">
            <dt>History: </dt><dd><DirectionalText>{content.changeSummary}</DirectionalText></dd>
          </div>}
          {contextLines.length > 0 && <div className="analyst-inbox-detail">
            <dt>Context: </dt><dd>
              {contextLines.map((text, index) => <span className="analyst-inbox-context-text" key={index}>{index > 0 && ' '}<DirectionalText>{text}</DirectionalText></span>)}
            </dd>
          </div>}
          </>}
        </dl>
        {durations.length > 0 && <HorizonTable durations={durations} stats={horizonStats[content.subject]} side={side} />}
        </div>
        <AnalystAlertThread findingId={finding.id} alert={alertSummary(finding, content, modern, date)}
          conversationId={threads[finding.id] || null} onCitation={onCitation} MessageComponent={MessageComponent}
          onStarted={(id, conversationId) => setThreads(previous => ({ ...previous, [id]: conversationId }))} />
        <footer className="analyst-inbox-footer" role="group" aria-label="Alert actions">
          <div className="analyst-inbox-evidence">
            {content.sourceLabel && <span className="analyst-inbox-source">{content.sourceLabel}</span>}
            <div className="analyst-inbox-actions">
              {citations.length > 0 && <button type="button" onClick={event => onCitation(citations[0], { relatedSources: citations.slice(1), anchor: event.currentTarget })}>Source</button>}
            </div>
          </div>
          {stamp || <span />}
          {Boolean(finding.unread) && <button className="analyst-inbox-acknowledge" type="button" onClick={() => modern
            ? onAcknowledge(finding.id, payload.fingerprint || finding.fingerprint, payload.materialRevision ?? finding.materialRevision) : onAcknowledge(finding.id)}>Dismiss</button>}
        </footer>
      </article>
      </React.Fragment>;
    })}
  </section>;
}
