import React, { useState } from 'react';
import { presentAnalystReportDates } from '../../utils/analystReportDates';
import AnalystSemanticText from './AnalystSemanticText';
import PortfolioReviewDateline from './PortfolioReviewDateline';
import { PortfolioReviewTextProvider } from './PortfolioReviewTextContext';
import { portfolioTopicTitle } from '../../utils/portfolioReviewTypography';
import { rollupDateline } from '../../utils/portfolioReviewDates';
import usePortfolioSecurityNames from '../../hooks/usePortfolioSecurityNames';
import './AnalystDailyRollup.css';
import LoadingIndicator from '../common/LoadingIndicator';

const text = value => typeof value === 'string' ? value.trim() : '';
const array = value => Array.isArray(value) ? value : [];
const savedColumnLabels = {
  Instrument: 'Securities',
  Instruments: 'Securities',
  'Source-listed instruments': 'Source-listed securities',
  'Macro Show positioning': 'Positioning',
  'The Call positioning': 'Positioning',
  'Research positioning': 'Positioning',
};
const columnLabel = value => savedColumnLabels[text(value)] || text(value);
const rangeSectionTitle = 'Trend/Ranges/Coverage/Outbucket';
const isRangeSection = section => section.id === 'risk-ranges'
  || /^(?:Trend\s*(?:&|and)\s*range(?:s| changes)|Trend\/Ranges\/Coverage\/Outbucket)$/i.test(text(section.title));
const sectionTitle = section => section.id === 'hedgai-signals' ? 'Tick' : isRangeSection(section) ? rangeSectionTitle : section.title;
const tableCaption = (section, block) => {
  if (isSignalStrength(section)) return signalStrengthCaption(block);
  if (!isRangeSection(section)) return text(block.title);
  if (block.columns.includes('OutBucket Trend')) return 'Outbucket';
  if (block.columns.includes('Coverage change')) return 'Coverage';
  if (block.columns.includes('Prior range') || block.columns.includes('Published range')) return 'Ranges';
  return block.trendShift || block.columns.includes('Prior Trend') ? 'Trend' : '';
};
const isSecurityComparison = columns => columns[0] === 'Ticker' && columns[1] === 'Security'
  && ['Prior Trend', 'Prior range'].includes(columns[2]);
// Prior Trend and Trend read as one shift: "Bullish → Neutral".
const isTrendShift = columns => columns.length === 4 && isSecurityComparison(columns) && columns[2] === 'Prior Trend' && columns[3] === 'Trend';
const trendShiftTable = block => !isTrendShift(block.columns) ? block : { ...block, trendShift: true,
  columns: ['Ticker', 'Security', 'Trend'],
  rows: block.rows.map(row => {
    const cells = array(row?.cells);
    const titles = array(row?.cellTitles).map(text);
    return { ...row, cells: [cells[0], cells[1], [text(cells[2]), text(cells[3])].filter(Boolean).join(' → ')],
      cellTitles: [titles[0], titles[1], [titles[2], titles[3]].filter(Boolean).join(' → ')],
      trendShift: [text(cells[2]) || '—', text(cells[3]) || '—'] };
  }) };
const isSecurityTable = columns => columns[0] === 'Ticker' && columns[1] === 'Security';
const isFactorTable = (section, block) => section.id === 'factor-exposure' && block.columns[0] === 'Factor';
// The full-book refresh sections (and their older position-alignment names)
// restated dated publisher actions with no current call; saved captures keep
// the facts, but Portfolio Review no longer shows them.
// Signal Strength Shorts was a trial subscription that ended (user-specified 2026-11-18).
// The Tick section (HedgAI Signals) was removed from the review (user-specified 2026-11-24); Tick stays on each position row.
const retiredSectionIds = new Set(['refresh-realignment', 'refresh-watch-list', 'refresh-aligned', 'refresh-sequence',
  'position-confirmations', 'position-contradictions', 'signal-strength-shorts', 'hedgai-signals']);
const retiredSectionTitles = new Set(['highest-priority realignment', 'watch list', 'what is already aligned', 'recommended sequence',
  'position confirmations', 'position contradictions', 'signal strength shorts', 'hedgai signals', 'tick']);
const isRetiredSection = section => retiredSectionIds.has(section?.id)
  || retiredSectionTitles.has(text(section?.title).toLowerCase());
const capturedSecurityName = value => /^(?:—|-|unavailable|unknown)$/i.test(text(value)) ? '' : text(value);
const isResearchPositioning = (section, block) => (['macro-show', 'company-catalysts', 'the-call'].includes(section.id)
  || /^(?:Macro Show|Company catalysts & sector research|The Call)$/i.test(text(section.title)))
  && block.columns.includes('Ticker') && block.columns.includes('Positioning');
const isMacroPositioningChange = (section, block) => (section.id === 'macro-show' || /^Macro Show$/i.test(text(section.title)))
  && block.columns.includes('Ticker') && block.columns.includes('Research positioning change');
const positioningChangeLabel = value => value
  .replace(/^Added to (Long|Short|Neutral) mentions$/, 'Added $1')
  .replace(/^No longer listed (Long|Short|Neutral)$/, 'Removed $1');
const hasRangeBoundaries = columns => isSecurityComparison(columns) && columns.includes('LOW') && columns.includes('HIGH');
const comparisonColumnClass = (column, index) => index === 0 ? 'analyst-ticker-column'
  : index === 1 ? 'analyst-security-column'
    : index === 2 ? 'analyst-prior-column'
      : index === 3 ? 'analyst-current-column'
        : ['LOW', 'HIGH'].includes(column) ? 'analyst-boundary-column' : 'analyst-context-column';
const boundaryTone = value => /^Higher\b/.test(value) ? 'positive' : /^Lower\b/.test(value) ? 'negative' : 'muted';
// Signal Strength reads as Changes (Added green, Removed red) then Current holdings with a signed Return
// (user-specified 2026-11-18).
const isSignalStrength = section => section.id === 'signal-strength' || /^Signal Strength$/i.test(text(section.title));
const signalStrengthCaption = block => block.columns.includes('Change') ? 'Changes'
  : block.columns.includes('Since signal') ? 'Current holdings' : text(block.title);
const signalStrengthTone = (column, value) => column === 'Change'
  ? (/^Added\b/i.test(value) ? 'positive' : /^Removed\b/i.test(value) ? 'negative' : '')
  : column === 'Since signal' ? (/^-|^−/.test(value) ? 'negative' : /^\+?\d*\.?\d*[1-9]/.test(value) ? 'positive' : '') : '';
const coverageChangeLabel = value => {
  const label = text(value);
  if (/^No longer in published range table[.]?$/i.test(label)) return '- Risk Ranges';
  const match = label.match(/^(?:was\s+)?(added to|removed from|moved to)\s+(?:the\s+)?#?(.+?)\s*[.]?$/i);
  return match ? `${/^removed/i.test(match[1]) ? '-' : '+'} ${match[2].replace(/[™®]/g, '')}` : label;
};
const displayTable = block => {
  const indexes = block.columns.map((column, index) => text(column).toLowerCase() !== 'research list' ? index : -1).filter(index => index >= 0);
  const columns = indexes.map(index => columnLabel(block.columns[index]));
  const legacyComparison = columns[0] === 'Securities' && ['Prior Trend', 'Prior range'].includes(columns[1]);
  return { ...block,
    columns: legacyComparison ? ['Ticker', 'Security', ...columns.slice(1)] : columns,
    rows: array(block.rows).map(row => {
      const cells = indexes.map(index => /^coverage change$/i.test(columnLabel(block.columns[index]))
        ? coverageChangeLabel(array(row?.cells)[index]) : array(row?.cells)[index]);
      const cellTitles = indexes.map(index => text(array(row?.cellTitles)[index]));
      const cellCitationIds = indexes.map(index => array(row?.cellCitationIds?.[index]));
      return { ...row, cells: legacyComparison ? [text(row?.ticker) || text(row?.symbol) || '—', ...cells] : cells,
        cellTitles: legacyComparison ? ['', ...cellTitles] : cellTitles,
        cellCitationIds: legacyComparison ? [[], ...cellCitationIds] : cellCitationIds };
    }),
  };
};
// Clarify dates in saved captures without rewriting their evidence or values.
const marketStructureDates = (section, blocks) => {
  if (section.id !== 'market-structure' && !/^Market structure & flows$/i.test(text(section.title))) return blocks;
  const isReadings = block => block.type === 'table' && block.columns.length === 3 && block.columns[0] === 'SPX metric'
    && block.columns[1] === 'Reading' && ['As of', 'Data as of'].includes(block.columns[2]);
  const dates = blocks.filter(isReadings).flatMap(block => block.rows.map(row => text(row.cells?.[2])));
  const sharedDate = dates.length && dates.every(date => date === dates[0])
    && /^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{4}$/.test(dates[0]) ? dates[0] : '';
  return blocks.map(block => {
    if (isReadings(block)) return { ...block, columns: ['SPX metric', 'Reading', 'Data as of'] };
    const publication = block.type === 'paragraph' && text(block.text).match(/^(?:Report:|Published) (\w{3} \d{1,2}, \d{4})$/);
    return publication ? { ...block, text: `Published ${publication[1]}${sharedDate ? ` · Data as of ${sharedDate}` : ''}` } : block;
  });
};
const blocksFor = section => marketStructureDates(section, (Array.isArray(section?.blocks) ? section.blocks : []).filter(block =>
  (block?.type === 'paragraph' && text(block.text))
  || (block?.type === 'table' && Array.isArray(block.columns) && block.columns.some(text)
    && Array.isArray(block.rows) && block.rows.some(row => Array.isArray(row?.cells) && row.cells.some(text))))
  .map(block => {
    if (block.type !== 'table') return block;
    const displayed = displayTable(block);
    return section.id === 'hedgai-signals' ? { ...displayed,
      columns: displayed.columns.map(column => ['Now', 'HedgAI'].includes(column) ? 'Tick' : column),
      disclosure: text(displayed.disclosure).replace(/^Full HedgAI book\b/, 'Full Tick book'),
    } : displayed;
  })
  .filter(block => block.type !== 'table' || block.columns.length > 0));

export const dailyRollupSections = rollup => rollup?.version === 1 && Array.isArray(rollup.sections)
  ? rollup.sections.filter(section => text(section?.title) && !isRetiredSection(section) && blocksFor(section).length) : [];

const dailySectionSlots = [
  { id: 'market-drivers', title: "Today's market drivers" },
  { id: 'risk-ranges', title: 'Trend & range changes' },
  { id: 'macro-regime', title: 'Macro & regime' },
  { id: 'macro-show', title: 'Macro Show' },
  { id: 'company-catalysts', title: 'Company catalysts & sector research' },
  { id: 'signal-strength', title: 'Signal Strength' },
  { id: 'market-structure', title: 'Market structure & flows' },
];
const modelSectionSlots = [
  { id: 'pca-risk', title: 'PCA risk' },
  { id: 'factor-exposure', title: 'Factor exposure' },
];
const stableDailySections = rollup => {
  const captured = rollup?.version === 1 ? array(rollup.sections).filter(section => text(section?.title) && !isRetiredSection(section)) : [];
  const byId = new Map(captured.map(section => [section.id, section]));
  const slots = [...modelSectionSlots, ...dailySectionSlots];
  const used = new Set();
  const projected = slots.map(slot => {
    const matches = [slot.id, ...array(slot.aliases)].map(id => byId.get(id)).filter(Boolean);
    matches.forEach(section => used.add(section));
    return { ...slot, ...matches[0], slotId: slot.id, supplemental: matches.slice(1) };
  });
  return [
    ...projected,
    ...captured.filter(section => !used.has(section)),
  ];
};

// A range moving wholly one way with a Trend that agrees tints its row (user-specified 2026-11-24):
// lower low, lower high and Bearish light red; higher low, higher high and Bullish light green.
const rangeAlignment = row => {
  const cells = new Set(array(row?.cells).map(cell => text(cell).toLowerCase()));
  if (cells.has('lower low') && cells.has('lower high') && cells.has('bearish')) return 'analyst-range-row--down';
  if (cells.has('higher low') && cells.has('higher high') && cells.has('bullish')) return 'analyst-range-row--up';
  return undefined;
};

// The Call's Signal Divergence lines ("WMT - Monitor SHORT / Signal Strength LONG") read as the two views they compare
// (user-specified 2026-11-24): Keith's Signal Strength list as Signal, over the sector analyst's position monitor as
// Analyst; off either is Neutral. Each side takes its direction's color.
const DIVERGENCE = /^(.*?)\s*[-–—]\s*(?:Off Monitor|Monitor (LONG|SHORT|NEUTRAL)) \/ (?:Off Signal Strength|Signal Strength (LONG|SHORT|NEUTRAL))$/i;
const divergenceSide = side => side ? `${side[0].toUpperCase()}${side.slice(1).toLowerCase()}` : 'Neutral';
const DIVERGENCE_TONE = { Long: 'signal-bullish', Short: 'signal-bearish', Neutral: 'signal-neutral' };

function SignalDivergence({ match }) {
  const sides = [['Signal', divergenceSide(match[3])], ['Analyst', divergenceSide(match[2])]];
  return <p className="analyst-signal-divergence">
    <span className="analyst-signal-divergence__ticker"><AnalystSemanticText context="Ticker">{match[1]}</AnalystSemanticText></span>
    <span className="analyst-signal-divergence__sides">{sides.map(([label, side]) =>
      <span key={label}>{label}: <span className={DIVERGENCE_TONE[side]}>{side}</span></span>)}</span>
  </p>;
}

function ReportParagraph({ block }) {
  const title = portfolioTopicTitle(block.text, block.title) || text(block.title);
  const body = title && block.text.startsWith(`${title} — `) ? block.text.slice(title.length + 3) : block.text;
  const divergence = text(body).match(DIVERGENCE);
  const content = divergence ? <SignalDivergence match={divergence} /> : <p><AnalystSemanticText>{body}</AnalystSemanticText></p>;
  if (!title) return divergence ? <div className="analyst-report-prose">{content}</div>
    : <p className="analyst-report-prose"><AnalystSemanticText>{block.text}</AnalystSemanticText></p>;
  return <div className="analyst-portfolio-topic-block analyst-report-prose">
    <h3 className="analyst-portfolio-topic analyst-process--title"><AnalystSemanticText>{title}</AnalystSemanticText></h3>
    {content}
  </div>;
}

function SecurityName({ row, cellIndex, currentIdentity }) {
  const captured = capturedSecurityName(row.cells[cellIndex]);
  const name = captured || currentIdentity?.name || text(row.cells[cellIndex]) || '—';
  const title = captured ? text(row.cellTitles?.[cellIndex]) || captured
    : currentIdentity ? `${currentIdentity.name} · Current security name · ${currentIdentity.source}` : undefined;
  return <span className="analyst-security-name" title={title}><AnalystSemanticText context="Security">{name}</AnalystSemanticText></span>;
}

function TickReading({ row, cellIndex, column }) {
  const value = text(row.cells[cellIndex]) || '—';
  const detail = text(row.cellTitles?.[cellIndex]);
  const title = presentAnalystReportDates(detail && !detail.includes(value) ? `${value} · ${detail}` : detail || value);
  return <span className="analyst-tick-reading" title={title}><AnalystSemanticText context={`Position ${column}`}>{value}</AnalystSemanticText></span>;
}

function PositioningLabel({ label }) {
  const change = /^(Added|Removed) (Long|Short|Neutral)$/.exec(label);
  if (!change) return <AnalystSemanticText context="Position">{label}</AnalystSemanticText>;
  const [, action, side] = change;
  const tone = side === 'Long' ? 'positive' : side === 'Short' ? 'negative' : 'muted';
  return <><span className={`analyst-process--${tone}`}>{action}</span>{' '}<AnalystSemanticText context="Position">{side}</AnalystSemanticText></>;
}

function PositioningList({ block, changes = false }) {
  const tickerIndex = block.columns.indexOf('Ticker');
  const securityIndex = block.columns.indexOf('Security');
  const sideIndex = block.columns.indexOf(changes ? 'Research positioning change' : 'Positioning');
  const sides = ['Long', 'Short', 'Neutral'];
  const labels = changes ? ['Added', 'Removed'].flatMap(action => sides.map(side => `${action} ${side}`)) : sides;
  const groups = new Map(labels.map(side => [side, new Map()]));
  block.rows.forEach(row => {
    const value = text(row?.cells?.[sideIndex]) || '—';
    const side = changes ? positioningChangeLabel(value) : value;
    const ticker = text(row?.cells?.[tickerIndex]) || '—';
    if (!groups.has(side)) groups.set(side, new Map());
    groups.get(side).set(ticker, text(row?.cells?.[securityIndex]));
  });
  return <div className="analyst-positioning-list">{[...groups].filter(([, tickers]) => tickers.size).map(([side, tickers]) =>
    <p key={side}><PositioningLabel label={side} />: {[...tickers].map(([ticker, security], index) =>
      <React.Fragment key={ticker}>{index > 0 && ', '}<span title={security || undefined}><AnalystSemanticText context="Ticker">{ticker}</AnalystSemanticText></span></React.Fragment>)}
    </p>)}</div>;
}

function TableDisclosure({ block, children }) {
  const [expanded, setExpanded] = useState(false);
  return text(block.disclosure)
    ? <details className="analyst-research-disclosure" open={expanded}><summary onClick={event => {
      event.preventDefault(); setExpanded(value => !value);
    }}><AnalystSemanticText>{block.disclosure}</AnalystSemanticText></summary>{expanded && children()}</details>
    : children();
}

const PENDING_WHEN_EMPTY = new Set(['pca-risk', 'factor-exposure']);

export default function AnalystDailyRollup({ rollup, citations = [], onCitation, holdingsAsOf, stableLayout = false, loading = false }) {
  const sections = stableLayout ? stableDailySections(rollup) : dailyRollupSections(rollup);
  const securityNames = usePortfolioSecurityNames(sections.flatMap(section =>
    blocksFor(section).filter(block => block.type === 'table' && isSecurityTable(block.columns)).flatMap(block =>
      block.rows.map(row => ({ holding: text(row.cells[0]), securityName: capturedSecurityName(row.cells[1]) })).filter(row => row.holding && row.holding !== '—'))));
  if (!sections.length) return null;
  const sources = new Map();
  [...array(citations), ...array(rollup?.citations)].forEach(source => {
    if (typeof source?.id === 'string') sources.set(source.id, { ...sources.get(source.id), ...source });
  });
  return <PortfolioReviewTextProvider rollup={rollup}><div className={`analyst-daily-rollup${stableLayout ? ' analyst-daily-rollup--stable' : ''}`}>{sections.map(section => {
    const blocks = blocksFor(section);
    const dates = rollupDateline(section, blocks, sources, holdingsAsOf);
    const contentBlocks = blocks.filter(block => block !== dates.consumed);
    // A source the user paused keeps its slot with a compact Pending state; PCA risk and Factor exposure
    // read Pending, not Unavailable, once loading ends with nothing (user-specified 2026-11-18).
    const paused = section.status === 'pending' && !contentBlocks.length;
    const idle = paused || PENDING_WHEN_EMPTY.has(section.id) ? 'Pending' : 'Unavailable';
    const shownBlocks = contentBlocks.map(block => block.type === 'table' ? trendShiftTable(block) : block);
    const content = <>
      {stableLayout && !contentBlocks.length && <p className="portfolio-review-section-status">{paused ? 'Pending' : loading ? <LoadingIndicator label="Loading…" size="sm" /> : idle}</p>}
      {shownBlocks.map((block, blockIndex) => block.type === 'paragraph'
        ? <ReportParagraph key={blockIndex} block={block} />
        : isResearchPositioning(section, block) ? <PositioningList key={blockIndex} block={block} />
        : isMacroPositioningChange(section, block) ? <PositioningList key={blockIndex} block={block} changes />
        : <TableDisclosure block={block} key={blockIndex}>{() => <div className="portfolio-brief-table-scroll">
          <table className={`portfolio-brief-table${isSecurityTable(block.columns) ? ' analyst-security-table' : ''}${isFactorTable(section, block) ? ' analyst-factor-table' : ''}${block.trendShift ? ' analyst-trend-shift' : ''}${section.id === 'hedgai-signals' && block.groupRows ? ` analyst-hedgai-table${block.disclosure ? ' analyst-hedgai-full-book' : ' analyst-hedgai-summary'}` : ''}${isSecurityComparison(block.columns) ? ` analyst-security-comparison${block.columns.length === 4 ? ' analyst-trend-comparison' : ''}${hasRangeBoundaries(block.columns) ? ' analyst-range-boundary-comparison' : ''}` : ''}`} aria-label={tableCaption(section, block) || sectionTitle(section)}>
            {tableCaption(section, block) && <caption>{tableCaption(section, block)}</caption>}
            {isSecurityTable(block.columns) && <colgroup>{block.columns.map((column, index) => <col key={index}
              className={isSecurityComparison(block.columns) || index < 2 ? comparisonColumnClass(column, index) : undefined} />)}</colgroup>}
            <thead><tr>{block.columns.map((column, index) => <th key={index} scope="col"><AnalystSemanticText>{isSignalStrength(section) && column === 'Since signal' ? 'Return' : columnLabel(column)}</AnalystSemanticText></th>)}</tr></thead>
            <tbody>{block.rows.filter(row => Array.isArray(row?.cells) && row.cells.some(text)).map((row, rowIndex, rows) =>
              <React.Fragment key={rowIndex}>
              {block.groupRows && text(row.group) && row.group !== rows[rowIndex - 1]?.group && <tr className="analyst-research-group"><th scope="rowgroup" colSpan={block.columns.length}><AnalystSemanticText>{row.group}</AnalystSemanticText></th></tr>}
              <tr className={rangeAlignment(row)}>{block.columns.map((column, cellIndex) => <td key={cellIndex} title={presentAnalystReportDates(text(row.cellTitles?.[cellIndex])) || undefined}>
                {columnLabel(column) === 'Security'
                  ? <SecurityName row={row} cellIndex={cellIndex} currentIdentity={securityNames[text(row.cells[0])]} />
                  : isFactorTable(section, block) && cellIndex === 0
                    ? <span className="analyst-factor-name" title={text(row.cellTitles?.[cellIndex]) || text(row.cells[cellIndex])}><AnalystSemanticText context="Factor">{text(row.cells[cellIndex]) || '—'}</AnalystSemanticText></span>
                  : section.id === 'hedgai-signals' && ['Tick', 'Position'].includes(columnLabel(column))
                    ? <TickReading row={row} cellIndex={cellIndex} column={column} />
                  : block.trendShift && cellIndex === 2
                    ? <span className="analyst-trend-shift-value"><AnalystSemanticText context="Prior Trend">{row.trendShift[0]}</AnalystSemanticText>{' → '}<AnalystSemanticText context="Trend">{row.trendShift[1]}</AnalystSemanticText></span>
                  : isSignalStrength(section) && signalStrengthTone(column, text(row.cells[cellIndex]))
                    ? <span className={`analyst-process--${signalStrengthTone(column, text(row.cells[cellIndex]))}`}>{text(row.cells[cellIndex])}</span>
                  : hasRangeBoundaries(block.columns) && ['LOW', 'HIGH'].includes(column)
                    ? <span className={`analyst-range-boundary analyst-process--${boundaryTone(text(row.cells[cellIndex]))}`}>{text(row.cells[cellIndex]) || '—'}</span>
                  : <AnalystSemanticText context={section.id === 'hedgai-signals' && cellIndex > 1 ? `Position ${text(column)}` : text(column)}>{text(row.cells[cellIndex]) || '—'}</AnalystSemanticText>}
              </td>)}</tr>
              </React.Fragment>)}</tbody>
          </table>
        </div>}</TableDisclosure>)}
      {/* No Sources footer: the section title already names the product (user-specified 2026-11-18). */}
      {section.supplemental?.length > 0 && <AnalystDailyRollup rollup={{ version: 1, sections: section.supplemental }}
        citations={[...sources.values()]} onCitation={onCitation} holdingsAsOf={holdingsAsOf} />}
    </>;
    return <section key={section.slotId || section.id || section.title} aria-label={sectionTitle(section)}
      aria-busy={stableLayout && !contentBlocks.length && loading && !paused ? true : undefined}
      className={['portfolio-review-section', section.id === 'hedgai-signals' && 'analyst-hedgai-section', blocks.some(block => block.type === 'table' && hasRangeBoundaries(block.columns)) && 'has-range-boundaries'].filter(Boolean).join(' ')}>
      <h2 className="analyst-portfolio-title"><AnalystSemanticText>{sectionTitle(section)}</AnalystSemanticText></h2>
      {/* An empty section has no dates to show, so no lone dash under its title. */}
      {(contentBlocks.length > 0 || !stableLayout) && <PortfolioReviewDateline text={dates.text} period={dates.period} />}
      {stableLayout ? <div className="portfolio-review-section-body">{content}</div> : content}
    </section>;
  })}</div></PortfolioReviewTextProvider>;
}
