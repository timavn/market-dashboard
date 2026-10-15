import React, { memo, useMemo } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import AnalystReportLink from './AnalystReportLink';
import AnalystPredictionRangeBar, { parsePredictionRange, predictionRangeLabel } from './AnalystPredictionRangeBar';
import AnalystPredictionDrivers, { parsePredictionDrivers } from './AnalystPredictionDrivers';
import remarkGfm from 'remark-gfm';
import { remarkAnalystProcessColors } from './analystProcessColors';
import { predictionReportSources } from './analystPredictionSources';
import { predictionReportTables } from './analystPredictionTables';
import { presentAnalystReportDates } from '../../utils/analystReportDates';
import './AnalystPredictionReport.css';

const nodeText = node => node?.type === 'text' ? node.value : (node?.children || []).map(nodeText).join('');
const reportPlugins = [remarkGfm, [remarkAnalystProcessColors, { reviewKind: 'prediction-markets-review' }]];
const dateValue = /^(?:(?:Published|As of|Since|Initiated|Last close) )?(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?: \d{1,2},)? \d{4}(?: \d{2}:\d{2} [A-Z]{2,4})?$/i;
const shortReading = /^(?:Last known\s+)?(?:Long|Short|Buy|Wait|Watch|Bullish|Bearish|Neutral)$/i;
// Setup board stacked cells: BIAS(direction;date;product) and MKT(name;sub-label).
const BIAS_TOKEN = /^BIAS\((Bullish|Bearish|Neutral|N\/A);([^;()]*);([^;()]*)\)$/;
const MARKET_TOKEN = /^(MKT|REF)\(([^;()]+);([^;()]+)\)$/;
// ASOF(pulled;tickDate,tickProduct;tradeDate,tradeProduct;trendDate,trendProduct)
const AS_OF_TOKEN = /^ASOF\(([^;()]*);([^;()]*),([^;()]*);([^;()]*),([^;()]*);([^;()]*),([^;()]*)\)$/;
// Two-digit days keep the right-aligned As of dates in one column: Sep 9 -> Sep 09.
const padDay = date => date.replace(/^([A-Za-z]{3}) (\d)\b/, '$1 0$2');
const BIAS_CLASS = { Bullish: 'analyst-process--positive', Bearish: 'analyst-process--negative' };
const MarkdownCell = ({ node, children }) => {
  const text = nodeText(node).trim();
  const bias = text.match(BIAS_TOKEN);
  if (bias) {
    const [, direction, date, product] = bias;
    const label = [direction, date, product].filter(Boolean).join(' · ');
    return <td className="analyst-prediction-bias-cell" title={label}>
      <span className={`analyst-prediction-stack ${BIAS_CLASS[direction] || 'analyst-prediction-stack--muted'}`}>{direction}</span>
      {date && <span className="analyst-prediction-stack">{date}</span>}
      {product && <span className="analyst-prediction-stack analyst-prediction-stack--muted">{product}</span>}
    </td>;
  }
  const market = text.match(MARKET_TOKEN);
  if (market) return <td className={market[1] === 'REF' ? 'analyst-prediction-reference-cell' : undefined} title={`${market[2]} · ${market[3]}`}>
    <span className="analyst-prediction-stack">{market[2]}</span>
    <span className="analyst-prediction-stack analyst-prediction-stack--muted">{market[3]}</span></td>;
  const asOf = text.match(AS_OF_TOKEN);
  if (asOf) {
    const [, pulled, ...rest] = asOf;
    const lines = [['Ti', rest[0], rest[1]], ['Ta', rest[2], rest[3]], ['Te', rest[4], rest[5]]];
    const label = [pulled, ...lines.map(([key, date, product]) => `${key} ${date ? `${date} ${product}`.trim() : 'N/A'}`)].join(' · ');
    return <td className="analyst-prediction-as-of-cell" title={label}>
      <span className="analyst-prediction-stack analyst-process--key">{pulled}</span>
      {lines.map(([key, date, product]) => <span key={key} className="analyst-prediction-stack analyst-prediction-as-of-line">
        <span className="analyst-prediction-stack__key">{key}</span>{' '}
        <span className="analyst-prediction-as-of-line__product analyst-prediction-stack--muted">{date ? product : ''}</span>{date && product ? ' ' : ''}
        <span className={`analyst-prediction-as-of-line__date${date ? '' : ' analyst-prediction-stack--muted'}`}>{date ? padDay(date) : 'N/A'}</span>
      </span>)}
    </td>;
  }
  const range = parsePredictionRange(nodeText(node));
  if (range) return <td className="analyst-prediction-range-cell" title={predictionRangeLabel(range).text}><AnalystPredictionRangeBar range={range} /></td>;
  const value = presentAnalystReportDates(nodeText(node));
  const dates = value.split(' · ');
  return <td title={value} className={shortReading.test(value) ? 'analyst-prediction-short-reading' : undefined}>{dates.every(date => dateValue.test(date))
    ? dates.map((date, index) => <React.Fragment key={`${date}-${index}`}>{index > 0 && ' · '}<span className="analyst-prediction-cell-date analyst-process--key">{date}</span></React.Fragment>)
    : children}</td>;
};
const MarkdownTable = ({ children, node }) => {
  const heading = node?.children?.find(child => child.tagName === 'thead')?.children?.find(child => child.tagName === 'tr');
  const headings = (heading?.children || []).filter(child => child.tagName === 'th').map(nodeText);
  const dated = /^(?:Date|As of|Last updated|Statistics date)$/i.test(headings.at(-1)?.trim() || '');
  const tickers = /^(?:Ticker|Symbol|Securities)$/i.test(headings[0]?.trim() || '');
  const securities = tickers && /^(?:Security|Company|Issuer)(?: name)?$/i.test(headings[1]?.trim() || '');
  const labels = /^(?:Metric|Signal|Factor)$/i.test(headings[0]?.trim() || '');
  const tickComparison = headings.join('|') === 'Ticker|Security|Tick|Contribution|Initiated|Bull history|Bear history|Statistics date';
  // Setup boards: saved captures used separate Price/Risk Range/In range columns; current ones use one range bar.
  const rangeBoard = headings.some(label => /^Price and Risk Range$/i.test(label.trim()));
  const setupBoard = rangeBoard || (headings.some(label => /^Setup$/i.test(label.trim()))
    && headings.some(label => /^In range$/i.test(label.trim())));
  const contractComparison = headings.some(label => /^Outcome$/i.test(label.trim()))
    && headings.some(label => /^Market-implied odds$/i.test(label.trim()));
  const contractColumn = label => {
    if (!contractComparison) return undefined;
    if (/^Level$/i.test(label.trim())) return 'analyst-prediction-contract-level-col';
    if (/^Outcome$/i.test(label.trim())) return 'analyst-prediction-contract-outcome-col';
    if (/^Side$/i.test(label.trim())) return 'analyst-prediction-contract-side-col';
    if (/^Price$/i.test(label.trim())) return 'analyst-prediction-contract-price-col';
    if (/^Market-implied odds$/i.test(label.trim())) return 'analyst-prediction-contract-odds-col';
    if (/^Gross reward\/risk \(before fees\)$/i.test(label.trim())) return 'analyst-prediction-contract-payoff-col';
    return undefined;
  };
  return <div className={`analyst-table-frame${dated ? ' has-dates' : ''}${tickers ? ' has-tickers' : ''}${securities ? ' has-securities' : ''}${labels ? ' has-labels' : ''}${tickComparison ? ' is-tick-comparison' : ''}${contractComparison ? ' is-contract-comparison' : ''}${setupBoard ? ' is-setup-board' : ''}${rangeBoard ? ' is-range-board' : ''}${rangeBoard && headings.some(label => /^Setup$/i.test(label.trim())) ? ' has-setup' : ''}`}>
    <table>{headings.length > 0 && <colgroup>{headings.map((label, index) => <col key={`${label}-${index}`} className={
      contractColumn(label) || (index === 0 && tickers ? 'analyst-prediction-ticker-col'
        : index === 1 && securities ? 'analyst-prediction-security-col'
          : index === 0 && labels ? 'analyst-prediction-metric-col'
            : index === headings.length - 1 && dated ? 'analyst-prediction-date-col' : undefined)
    } />)}
    </colgroup>}{children}</table>
  </div>;
};
// ```analyst-drivers blocks carry a section's shared variables; other code blocks render normally.
const MarkdownPre = ({ node, children }) => {
  const code = node?.children?.find(child => child.tagName === 'code');
  const classes = [].concat(code?.properties?.className || []);
  const drivers = classes.includes('language-analyst-drivers') ? parsePredictionDrivers(nodeText(code)) : null;
  return drivers ? <AnalystPredictionDrivers drivers={drivers} /> : <pre>{children}</pre>;
};
const SourceButton = ({ group, onCitation, children }) => <button type="button" className="analyst-prediction-source"
  aria-label={`Source: ${group.label}`} title={group.source.title || group.label}
  onClick={() => onCitation?.(group.source, group.context)}>{children || group.label}</button>;

const AnalystPredictionReport = memo(function AnalystPredictionReport({ messageId, markdown, citations, onCitation, error }) {
  const report = useMemo(() => {
    const sourced = predictionReportSources(markdown, citations);
    return { ...sourced, markdown: predictionReportTables(sourced.markdown) };
  }, [markdown, citations]);
  const parts = useMemo(() => {
    const match = report.markdown.match(/<details data-analyst-hedgai>\s*<summary>([^<\n]+)<\/summary>\s*([\s\S]*?)\s*<\/details>/);
    return match ? { body: report.markdown.replace(match[0], ''), title: match[1].replace(/^HedgAI comparison\b/, 'Tick comparison'), detail: match[2] } : { body: report.markdown };
  }, [report.markdown]);
  const components = useMemo(() => ({
    table: MarkdownTable,
    td: MarkdownCell,
    pre: MarkdownPre,
    // Older captures keep their original evidence and publication names. Only
    // the generated signal-field label follows today's Tick terminology.
    strong: ({ node, children }) => <strong>{nodeText(node) === 'HedgAI:' ? 'Tick:' : children}</strong>,
    a: ({ href, children }) => report.links.has(href)
      ? <SourceButton group={report.links.get(href)} onCitation={onCitation}>{children}</SourceButton>
      : <AnalystReportLink href={href}>{children}</AnalystReportLink>,
    p: ({ node, children }) => <p className={/^Sources?:\s/i.test(node.children?.[0]?.value || '') ? 'analyst-prediction-sources' : undefined}>{children}</p>,
  }), [report.links, onCitation]);
  return <article data-message-id={messageId} className={`analyst-message analyst-message--assistant analyst-prediction-report${error ? ' is-error' : ''}`} aria-label="Predictive Markets Review">
    <div className="analyst-markdown">
      <ReactMarkdown remarkPlugins={reportPlugins} components={components}
        urlTransform={url => report.links.has(url) ? url : defaultUrlTransform(url)}>
        {parts.body.replaceAll('<!-- analyst-prediction-research-rollup -->', '')
          .replaceAll('<!-- analyst-details -->', '\n\n')}
      </ReactMarkdown>
      {parts.detail && <details className="analyst-research-disclosure"><summary>{parts.title}</summary>
        <ReactMarkdown remarkPlugins={reportPlugins} components={components}
          urlTransform={url => report.links.has(url) ? url : defaultUrlTransform(url)}>{parts.detail}</ReactMarkdown>
      </details>}
      {report.remaining.length > 0 && <p className="analyst-prediction-sources"><span>Sources: </span>{report.remaining.map((group, index) =>
        <React.Fragment key={group.source.id}>{index > 0 && ', '}<SourceButton group={group} onCitation={onCitation} /></React.Fragment>)}</p>}
    </div>
  </article>;
});
export default AnalystPredictionReport;
