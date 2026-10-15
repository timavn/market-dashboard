import React, { useContext } from 'react';
import { analystSemanticRanges } from './analystProcessColors';
import { portfolioCompanyNameRanges, portfolioTickerRanges } from '../../utils/portfolioReviewTypography';
import { PortfolioReviewCompanyNamesContext, PortfolioReviewTextContext } from './PortfolioReviewTextContext';
import { presentAnalystReportDates } from '../../utils/analystReportDates';
import { analystReportHighlightRanges } from '../../utils/analystReportHighlights';
import './AnalystReportText.css';

export default function AnalystSemanticText({ children, context = '' }) {
  const tickers = useContext(PortfolioReviewTextContext);
  const companyNames = useContext(PortfolioReviewCompanyNamesContext);
  if (typeof children !== 'string') return children ?? null;
  const text = presentAnalystReportDates(children);
  const names = tickers ? portfolioCompanyNameRanges(text, companyNames || new Set(), context) : [];
  // Words inside an exact company name identify that security. Independently
  // reported direction and Quad words outside the name retain their meaning.
  const ranges = [...names, ...analystSemanticRanges(text, context)
    .filter(range => !names.some(name => range.start < name.end && range.end > name.start))];
  if (tickers) {
    const identities = portfolioTickerRanges(text, tickers, context);
    ranges.push(...identities.filter(identity => !ranges.some(range => identity.start < range.end && identity.end > range.start)));
  }
  ranges.push(...analystReportHighlightRanges(text, context).filter(key => !ranges.some(range => key.start < range.end && key.end > range.start)));
  ranges.sort((a, b) => a.start - b.start);
  if (!ranges.length) return text;
  const content = [];
  let cursor = 0;
  ranges.forEach(({ start, end, tone }) => {
    if (start > cursor) content.push(text.slice(cursor, start));
    content.push(<span key={start} className={`analyst-process--${tone}`}>{text.slice(start, end)}</span>);
    cursor = end;
  });
  if (cursor < text.length) content.push(text.slice(cursor));
  return <>{content}</>;
}
