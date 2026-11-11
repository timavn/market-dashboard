import React, { useEffect, useState } from 'react';
import { analystWorkspaceApi as api } from '../../services/analyst/analystClient';
import AnalystAlertThread from './AnalystAlertThread';
import { describeAnalystFinding } from '../../utils/analystFindingPresentation.cjs';
import { activeAttentionFinding, attentionEvidenceFreshness, attentionPriority, isActionRequired, isAttentionFinding } from '../../utils/analystInboxAlerts.cjs';
import AnalystPredictionRangeBar from './AnalystPredictionRangeBar';
import './AnalystPredictionReport.css';
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
// date-only publication, so it shows when the alert reached the Inbox instead, and
// the date alone only when that is unknown too.
const timed = time => time && Number.isFinite(new Date(time).getTime()) && !/T00:00:00(?:\.0+)?Z$/.test(time);
function publicationLabel(time, date, receivedAt) {
  if (!timed(time) && timed(receivedAt)) return publicationLabel(receivedAt);
  const at = new Date(time);
  if (timed(time)) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(at).map(part => [part.type, part.value]));
    return `${parts.month} ${parts.day} ${parts.hour}:${parts.minute}`;
  }
  const day = new Date(`${String(date || time || '').slice(0, 10)}T12:00:00Z`);
  if (!Number.isFinite(day.getTime())) return null;
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(day);
}

// When an alert was dismissed: its dismissal record, else the row's acknowledgment.
const DISMISSED_WINDOW_MS = 24 * 60 * 60_000;
const dismissedAt = finding => Date.parse((finding.payload || finding).dismissed?.at || finding.acknowledged_at) || 0;

// Security and market alerts (an Alpha Code line break) lead with their ticker; operational subjects are not tickers.
const TICKER_KINDS = new Set(['portfolio', 'opportunity', 'market']);
// Source is for published products. The dashboard's own calculations and health checks have none to show.
const INTERNAL_SOURCES = new Set(['process-sizing', 'portfolio-balance', 'dashboard-health']);
const publishedSource = link => Boolean(link?.citation) && !INTERNAL_SOURCES.has(link.citation.product);

// An urgent instruction remains visible during a holdings outage; say which
// verification it rests on instead of presenting the position as current.
function staleHoldingLabel(payload) {
  const side = payload.quantity > 0 ? 'Long' : payload.quantity < 0 ? 'Short' : 'Not held';
  const at = new Date(payload.holdingsVerifiedAt);
  return Number.isFinite(at.getTime())
    ? `${side} (last verified ${new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(at)}; holdings currently unavailable)`
    : `${side} (holdings currently unavailable)`;
}

// The publication a link cites, by product: "The Call", not "The Call @ Hedgeye | Replay…".
// Generic labels ("Trade source", "atr14 evidence") fall back to the citation's own title.
function sourceName(link) {
  const label = String(link.label || '').replace(/\s+Alpha Code$/, '').trim();
  if (label && !/\b(?:source|evidence)$/i.test(label)) return label;
  return String(link.citation?.title || '').split(/:| @ | \| /)[0].trim() || null;
}

// The card opens on what it is about. A terse "condition → action" Context says that and replaces the
// plainer Action row, which only restates it; prose Context stays below as explanation and the Action row leads.
const UNDER_LEAD = ['Previous', 'New'];

function leadWithAction(rows) {
  const context = rows.find(row => row.label === 'Context' && row.text.includes('→'));
  const lead = context || rows.find(row => row.label === 'Action');
  // A notification has no Action; its Signal takes the same bold first line.
  if (!lead) {
    const signal = rows.find(row => row.label === 'Signal');
    return signal ? [{ ...signal, lead: true }, ...rows.filter(row => row !== signal)] : rows;
  }
  return [{ ...lead, label: 'Action', lead: true }, ...rows.filter(row => row !== lead && !(context && row.label === 'Action'))];
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
    // The position reads as its weight alone, colored by side ("1.97%" in green for Long);
    // without a verified weight it falls back to side and shares.
    .reduce((merged, row) => {
      const index = merged.findIndex(item => item.label === 'Current position');
      if (row.label !== 'Position size' || index < 0) return [...merged, row];
      const position = merged[index];
      if (row.text === 'Unavailable' || !['Long', 'Short'].includes(position.text)) return merged;
      return merged.map((item, i) => i === index ? { ...position, text: row.text, side: position.text } : item);
    }, []);
  if (!rows.length) return null;
  // A security card names its publications at a glance, right under the position.
  const sources = [...new Set((presentation.sourceLinks || []).filter(publishedSource).map(sourceName).filter(Boolean))];
  if (TICKER_KINDS.has(payload.kind) && sources.length && !rows.some(row => row.label === 'Source')) {
    const at = rows.findIndex(row => row.label === 'Current position') + 1;
    rows.splice(at, 0, { label: 'Source', text: sources.join(', ') });
  }
  return { ...presentation, rows: leadWithAction(rows), publicationDate: presentation.date || payload.publicationTime,
    sortTime: Date.parse(payload.publicationTime) || Date.parse(presentation.date) || 0 };
}

const signed = (value, digits = 1) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(digits)}%`;
const toneClass = tone => tone ? `analyst-inbox-signal--${tone}` : undefined;

// Price windows are colored by their own sign, whichever side is held: down is
// always red. Volatility is red only when it runs well above its one-year level.
// Volume carries no direction of its own.
function horizonRows(stats) {
  const columns = stats?.columns || HORIZONS.map(label => ({ label }));
  const against = value => value == null || value === 0 ? null : value > 0 ? 'positive' : 'negative';
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

function HorizonTable({ durations, stats }) {
  return <table className="analyst-inbox-horizons">
    <colgroup><col className="analyst-inbox-horizons-label" />{HORIZONS.map(label => <col key={label} className="analyst-inbox-horizons-column" />)}</colgroup>
    <thead><tr><td />{durations.map(row => <th key={row.label} scope="col">{row.label}</th>)}</tr></thead>
    <tbody>
      {/* Each duration reads Bullish, Neutral, Bearish or N/A. Where a reading came from
          (stated, or RTA / ETF Pro list membership) is in its tooltip only. */}
      <tr className="analyst-inbox-bias"><td />{durations.map(row => <td key={row.label}>
        <span className={`analyst-inbox-bias-cell is-${BIAS_TONES[row.text] || 'unavailable'}`} title={row.note}>{BIAS_TONES[row.text] ? row.text : 'N/A'}</span>
      </td>)}</tr>
      <tr className="analyst-inbox-horizon-head"><td />{(stats?.columns || HORIZONS.map(label => ({ label }))).map(column => <th key={column.label} scope="col">{column.label}</th>)}</tr>
      {horizonRows(stats).map(([label, cells]) => <tr key={label}>
        <th scope="row" title={label === 'Range position' ? 'Close between the window low (0%) and high (100%)' : undefined}>{label}</th>
        {cells.map((cell, index) => <td key={index} className={toneClass(cell.tone)}>{cell.text}</td>)}
      </tr>)}
    </tbody>
  </table>;
}

const STANCE_TONES = { LONG: 'positive', SHORT: 'negative', BUY: 'positive', SELL: 'negative', BULLISH: 'positive', BEARISH: 'negative', NEUTRAL: 'neutral' };
const callDate = date => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
const amount = value => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
const Toned = ({ value }) => <span className={toneClass(STANCE_TONES[value])}>{value}</span>;
// A position reads as its % of the portfolio, green Long and red Short; shares
// belong only to the order. Without a verified weight it reads —.
function stancePosition(position) {
  if (position.quantity === 0) return '0.00%';
  if (position.weightPct === null || position.weightPct === undefined) return '—';
  return <span className={toneClass(STANCE_TONES[position.side])}>{position.weightPct.toFixed(2)}%</span>;
}
// "Sell 150 shares": the verb carries the color, as in the stance order cell.
function OrderText({ children }) {
  const [verb, ...rest] = String(children).split(' ');
  const tone = STANCE_TONES[verb.toUpperCase()];
  return tone ? <><span className={toneClass(tone)}>{verb}</span>{rest.length ? ` ${rest.join(' ')}` : ''}</> : children;
}
const orderShares = order =>order.quantity === null ? 'some' : `${amount(order.quantity)} ${order.quantity === 1 ? 'share' : 'shares'}`;

// Stance alerts: the latest product calls, then the move from the current
// position to the target and the order that gets there.
function StanceCopy({ ticker, stance, freshHoldings }) {
  const { calls, current, target, order } = stance;
  return <div className="analyst-inbox-copy analyst-inbox-stance">
    <div className="analyst-inbox-stance-title"><span className="analyst-inbox-stance-ticker">{ticker}</span>{stance.name && <span>{stance.name}</span>}</div>
    <table className="analyst-inbox-stance-table">
      <colgroup><col style={{ width: '35%' }} /><col style={{ width: '24%' }} /><col style={{ width: '16%' }} /><col style={{ width: '25%' }} /></colgroup>
      <thead><tr><th scope="col">Product</th><th scope="col">Action</th><th scope="col">Date</th><th scope="col">Bias</th></tr></thead>
      <tbody>{calls.map((call, index) => <tr key={index}>
        <td>{call.product}</td><td><Toned value={call.action} /></td><td>{callDate(call.date)}</td><td><Toned value={call.bias} /></td>
      </tr>)}</tbody>
    </table>
    <table className="analyst-inbox-stance-table analyst-inbox-stance-order">
      <colgroup><col style={{ width: '32%' }} /><col style={{ width: '32%' }} /><col style={{ width: '36%' }} /></colgroup>
      <thead><tr><th scope="col">Current</th><th scope="col">Target</th><th scope="col">Order</th></tr></thead>
      <tbody><tr>{freshHoldings ? <>
        <td>{stancePosition(current)}</td><td>{stancePosition(target)}</td>
        <td><Toned value={order.verb} /> {orderShares(order)}</td>
      </> : <><td className="analyst-inbox-signal--neutral">Unavailable</td><td>—</td><td>—</td></>}</tr></tbody>
    </table>
  </div>;
}

// The alert as the user reads it, so the Analyst discusses this exact card.
function alertSummary(finding, content, modern, date) {
  const payload = finding.payload || finding;
  const title = `${modern ? content.subject : finding.symbol || payload.symbol}${date ? ` (${date})` : ''}`;
  const lines = modern ? content.rows.map(row => `${row.label}: ${row.side ? `${row.side} ` : ''}${row.text}${row.note ? ` (${row.note})` : ''}`) : [
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
  const describe = list => list
    .map(finding => ({ finding, modern: isAttentionFinding(finding),
      content: isAttentionFinding(finding) ? attentionContent(finding, now) : describeAnalystFinding(finding, findings, now) }))
    .filter(({ finding, content }) => content && content.positionAction !== 'Neutral — no change'
      && !['resolved', 'unavailable'].includes(finding.state || finding.payload?.state));
  const unread = finding => finding.unread !== 0 && finding.unread !== false;
  const alerts = describe(findings.filter(unread))
    .sort((a, b) => attentionPriority(a.finding) - attentionPriority(b.finding)
      || (b.content.sortTime || Date.parse(b.content.publicationDate) || 0) - (a.content.sortTime || Date.parse(a.content.publicationDate) || 0));
  // Alerts dismissed in the last day stay one click away, most recently dismissed first.
  const [showDismissed, setShowDismissed] = useState(false);
  const dismissedList = describe(findings.filter(finding => !unread(finding) && now - dismissedAt(finding) < DISMISSED_WINDOW_MS))
    .sort((a, b) => dismissedAt(b.finding) - dismissedAt(a.finding));
  const securities = [...new Set([...alerts, ...(showDismissed ? dismissedList : [])].filter(({ modern, content }) => modern && content.rows.some(row => DURATIONS.includes(row.label)))
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
    {[...urgent, ...ordinary].map((item, index) => card(item, index))}
    {showDismissed && dismissedList.length > 0 && <>
      <h2 className="analyst-inbox-dismissed-heading">Dismissed · last 24 hours</h2>
      {dismissedList.map((item, index) => card(item, index, dismissedAt(item.finding)))}
    </>}
    {dismissedList.length > 0 && <div className="analyst-inbox-dismissed-bar">
      <button type="button" aria-expanded={showDismissed} onClick={() => setShowDismissed(open => !open)}>
        {showDismissed ? 'Hide dismissed' : `Dismissed (${dismissedList.length})`}</button>
    </div>}
  </section>;

  function card({ finding, content, modern }, index, dismissed = null) {
      const payload = finding.payload || finding;
      const date = publicationLabel(payload.publicationTime, content.publicationDate, payload.receivedAt);
      const subject = modern ? content.subject : finding.symbol || payload.symbol;
      const ticker = modern ? TICKER_KINDS.has(payload.kind) && subject : subject;
      // Centered in the footer between Source and Dismiss.
      const shownAt = !timed(payload.publicationTime) && timed(payload.receivedAt) ? payload.receivedAt : payload.publicationTime || content.publicationDate;
      const stamp = date && <time className="analyst-inbox-time" dateTime={shownAt}>{date}</time>;
      const updateParts = content.updateParts || [{ text: content.headline, tone: content.tone }];
      const contextLines = [content.detail, ...(content.sourceContext || [])].filter(Boolean);
      const required = isActionRequired(finding);
      const stance = modern && content.stance?.calls?.length ? content.stance : null;
      // Every linked publication opens from one Source popover beside the button.
      const durations = modern ? DURATIONS.map(label => content.rows.find(row => row.label === label)).filter(Boolean) : [];
      const lead = modern ? content.rows.find(row => row.lead) : null;
      // The Risk Range is drawn as its bar under the copy, with its numbers on it, not as a line of text.
      const copyRows = modern ? content.rows.filter(row => !DURATIONS.includes(row.label) && !row.lead && !row.range) : [];
      // An Alpha Code change reads Previous then New straight under its Signal.
      const underLead = copyRows.filter(row => UNDER_LEAD.includes(row.label));
      const rows = copyRows.filter(row => !UNDER_LEAD.includes(row.label));
      const riskRange = modern ? content.rows.find(row => row.range)?.range : null;
      const citations = content.sourceLinks?.length ? content.sourceLinks.filter(link => publishedSource(link) && link.label).map(link => link.citation)
        : payload.citation ? [payload.citation] : [];
      return <React.Fragment key={finding.id}>
      {!dismissed && !required && index === urgent.length && urgent.length > 0 && <h2 className="analyst-inbox-ordinary-heading">Notifications</h2>}
      <article className={`analyst-inbox-finding${finding.unread ? ' is-unread' : ''}${required ? ' is-action-required' : ''}${dismissed ? ' is-dismissed' : ''}`}>
        <h3 className="sr-only">{subject}</h3>
        <div className={durations.length ? 'analyst-inbox-body has-horizons' : 'analyst-inbox-body'}>
        {stance ? <StanceCopy ticker={subject} stance={stance} freshHoldings={attentionEvidenceFreshness(finding, now).holdings} /> : <dl className="analyst-inbox-copy">
          {lead && <div className="analyst-inbox-lead">
            <dt>{lead.label}: </dt><dd>{lead.beyondRange && lead.text.includes(' → ')
              ? <><span className="analyst-inbox-beyond-range">{lead.text.split(' → ')[0]}</span> → <DirectionalText>{lead.text.split(' → ').slice(1).join(' → ')}</DirectionalText></>
              : <DirectionalText>{lead.text}</DirectionalText>}</dd>
          </div>}
          {underLead.map(row => <div key={row.label}><dt>{row.label}: </dt><dd>{row.text}</dd></div>)}
          {ticker && <div className="analyst-inbox-ticker">
            <dt>Ticker: </dt><dd>{ticker}</dd>
          </div>}
          {modern ? rows.map((row, index) => row.text.includes('\n') ? <div key={`${row.label}-${index}`} className="analyst-inbox-stack">
            {/* A history row (line crosses) stacks one entry per line, newest on top, aligned under each other. */}
            <dt>{row.label}: </dt><dd>{row.text.split('\n').map((entry, line) => <span key={line} className={line ? 'analyst-inbox-stack__older' : undefined}>
              <DirectionalText>{entry}</DirectionalText></span>)}</dd>
          </div> : <div key={`${row.label}-${index}`}>
            <dt>{row.label}: </dt><dd className={row.side ? toneClass(STANCE_TONES[row.side.toUpperCase()]) : ['Unavailable', 'N/A'].includes(row.text) ? 'analyst-inbox-signal--neutral' : undefined}>
              {row.side && `${row.side.toUpperCase()} `}{row.label === 'Order' ? <OrderText>{row.text}</OrderText> : row.label === 'Source' ? row.text : <DirectionalText>{row.text}</DirectionalText>}</dd>
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
          {riskRange && <div className="analyst-inbox-range"><dd><AnalystPredictionRangeBar range={riskRange} /></dd></div>}
        </dl>}
        {durations.length > 0 && <HorizonTable durations={durations} stats={horizonStats[content.subject]} />}
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
          {dismissed && <span className="analyst-inbox-acknowledge analyst-inbox-time">Dismissed {publicationLabel(new Date(dismissed).toISOString())}</span>}
        </footer>
      </article>
      </React.Fragment>;
  }
}
