import React, { useMemo } from 'react';
import { analystSourceHighlightRanges } from '../../utils/analystSourceHighlights';
import './AnalystSourceExcerpt.css';

export default function AnalystSourceExcerpt({ excerpt, highlightTexts }) {
  const source = typeof excerpt === 'string' ? excerpt : '';
  const ranges = useMemo(() => analystSourceHighlightRanges(source, highlightTexts), [source, highlightTexts]);
  const content = [];
  let cursor = 0;
  ranges.forEach(({ start, end }) => {
    if (start > cursor) content.push(source.slice(cursor, start));
    content.push(<mark key={start}>{source.slice(start, end)}</mark>);
    cursor = end;
  });
  if (cursor < source.length) content.push(source.slice(cursor));
  return <blockquote className="analyst-source-excerpt">{content}</blockquote>;
}
