import React from 'react';
import { safeResearchUrl } from '../../utils/researchSourceUrl';

/** Malformed saved references are text, never empty URLs or app routes that
 * could reload the conversation. */
export default function AnalystReportLink({ href, children }) {
  const original = safeResearchUrl(href);
  return original
    ? <a href={original} target="_blank" rel="noopener noreferrer">{children}</a>
    : <span>{children}</span>;
}
