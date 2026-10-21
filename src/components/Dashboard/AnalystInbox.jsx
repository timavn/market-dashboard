import React, { useEffect, useState } from 'react';
import { describeAnalystFinding } from '../../utils/analystFindingPresentation.cjs';
import { activeAttentionFinding, attentionEvidenceFreshness, attentionPriority, isActionRequired, isAttentionFinding } from '../../utils/analystInboxAlerts.cjs';
import './AnalystInbox.css';

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

function publicationLabel(value) {
  if (!value) return null;
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00Z`);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  }).format(date);
}

// An urgent instruction remains visible during a holdings outage; say which
// verification it rests on instead of presenting the position as current.
function staleHoldingLabel(payload) {
  const side = payload.quantity > 0 ? 'Long' : payload.quantity < 0 ? 'Short' : 'Not held';
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
    }, []);
  if (!rows.length) return null;
  return { ...presentation, rows, publicationDate: presentation.date || payload.publicationTime,
    sortTime: Date.parse(payload.publicationTime) || Date.parse(presentation.date) || 0 };
}

export default function AnalystInbox({ findings = [], error = '', onCitation, onAcknowledge }) {
  const [now, setNow] = useState(Date.now);
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
  const urgent = alerts.filter(({ finding }) => isActionRequired(finding));
  const ordinary = alerts.filter(({ finding }) => !isActionRequired(finding));

  return <section className="analyst-inbox" aria-label="Portfolio inbox">
    {error && <p className="analyst-inbox-error" role="alert">{error}</p>}
    {!alerts.length && <p className="analyst-inbox-empty">No new items requiring attention.</p>}
    {urgent.length > 0 && <h2 className="analyst-inbox-urgent-heading">Alerts</h2>}
    {[...urgent, ...ordinary].map(({ finding, content, modern }, index) => {
      const payload = finding.payload || finding;
      const date = publicationLabel(content.publicationDate);
      const updateParts = content.updateParts || [{ text: content.headline, tone: content.tone }];
      const contextLines = [content.detail, ...(content.sourceContext || [])].filter(Boolean);
      const required = isActionRequired(finding);
      // Every linked publication opens from one Source popover beside the button.
      const citations = content.sourceLinks?.length ? content.sourceLinks.filter(link => link?.citation && link.label).map(link => link.citation)
        : payload.citation ? [payload.citation] : [];
      return <React.Fragment key={finding.id}>
      {!required && index === urgent.length && urgent.length > 0 && <h2 className="analyst-inbox-ordinary-heading">Notifications</h2>}
      <article className={`analyst-inbox-finding${finding.unread ? ' is-unread' : ''}${required ? ' is-action-required' : ''}`}>
        <header className="analyst-inbox-heading">
          <h3 className="analyst-inbox-symbol">{modern ? content.subject : finding.symbol || payload.symbol}</h3>
          {date && <time dateTime={content.publicationDate}>{date}</time>}
        </header>
        <dl className="analyst-inbox-copy">
          {modern ? content.rows.map((row, index) => <div key={`${row.label}-${index}`}>
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
        <footer className="analyst-inbox-footer" role="group" aria-label="Alert actions">
          <div className="analyst-inbox-evidence">
            {content.sourceLabel && <span className="analyst-inbox-source">{content.sourceLabel}</span>}
            <div className="analyst-inbox-actions">
              {citations.length > 0 && <button type="button" onClick={event => onCitation(citations[0], { relatedSources: citations.slice(1), anchor: event.currentTarget })}>Source</button>}
            </div>
          </div>
          {Boolean(finding.unread) && <button className="analyst-inbox-acknowledge" type="button" onClick={() => modern
            ? onAcknowledge(finding.id, payload.fingerprint || finding.fingerprint, payload.materialRevision ?? finding.materialRevision) : onAcknowledge(finding.id)}>Dismiss</button>}
        </footer>
      </article>
      </React.Fragment>;
    })}
  </section>;
}
