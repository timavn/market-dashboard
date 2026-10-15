import React from 'react';
import { safeResearchUrl } from '../../utils/researchSourceUrl';

/** Citation controls stay inside the workspace. Malformed saved references are
 * text, never empty URLs or app routes that could reload the conversation. */
export default function AnalystReportLink({ href, source, context, onCitation, children }) {
  if (source) return <button type="button" className="analyst-section-source analyst-action-source"
    onClick={event => { event.preventDefault(); event.stopPropagation(); onCitation?.(source, context || {}); }}>{children}</button>;
  const original = safeResearchUrl(href);
  return original
    ? <a href={original} target="_blank" rel="noopener noreferrer">{children}</a>
    : <span>{children}</span>;
}
