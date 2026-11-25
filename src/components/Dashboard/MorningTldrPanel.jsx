import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSurfaceActivity } from '../common/PersistentSurface';
import { MarketDataService } from '../../services/api/marketDataService';
import { useMarketStructureReport } from '../../hooks/useMarketStructureReport';
import RefreshButton from '../common/RefreshButton';
import MarketSituationReportCard from './MarketSituationReportCard';
import {
  TLDR_PRODUCT_DEFINITIONS,
  articleSections,
  articleTakeaways,
  asArray,
  buildRiskRangeComparison,
  cleanPosition,
  countChanges,
  diffPositionGroups,
  formatNumber,
  formatTimestamp,
  getPositionGroups,
  getRiskRangeRows,
  getSignalChanges,
  getTopThreeThings,
  snapshotLabel,
  todayInNewYork,
} from '../../utils/morningTldr';
import {
  computeRiskRangeActionability,
  computeRiskRangePercents,
} from '../../utils/riskRangePercents';
import { startVisibilityAwarePolling } from '../../utils/visibilityAwarePolling';
import './MorningTldrPanel.css';
import LoadingIndicator from '../common/LoadingIndicator';

const PRODUCT_IDS = TLDR_PRODUCT_DEFINITIONS.map((product) => product.id);
const COMPARABLE_PRODUCT_IDS = PRODUCT_IDS.filter((id) => id !== 'market-structure');
const SEARCH_HIGHLIGHT_NAME = 'morning-tldr-search-match';
const SEARCH_CURRENT_HIGHLIGHT_NAME = 'morning-tldr-search-current';
const MAX_SEARCH_MATCHES = 250;
export const TLDR_STATUS_POLL_INTERVAL_MS = 5 * 60 * 1000;

const searchHighlightRegistry = () => (
  typeof window !== 'undefined' && window.CSS?.highlights ? window.CSS.highlights : null
);

const clearSearchHighlights = (root) => {
  const registry = searchHighlightRegistry();
  registry?.delete?.(SEARCH_HIGHLIGHT_NAME);
  registry?.delete?.(SEARCH_CURRENT_HIGHLIGHT_NAME);
  root?.querySelectorAll?.('[data-tldr-search-match], [data-tldr-search-current]').forEach((node) => {
    node.removeAttribute('data-tldr-search-match');
    node.removeAttribute('data-tldr-search-current');
  });
};

const isTickerSearch = (query) => /^[A-Za-z][A-Za-z0-9./-]{0,9}$/.test(query);
const isTickerCharacter = (value) => /[A-Za-z0-9]/.test(value || '');

const searchSnippet = (text, start, length) => {
  const left = Math.max(0, start - 34);
  const end = start + length;
  const right = Math.min(text.length, end + 54);
  return {
    before: `${left > 0 ? '…' : ''}${text.slice(left, start).replace(/\s+/g, ' ')}`,
    match: text.slice(start, end),
    after: `${text.slice(end, right).replace(/\s+/g, ' ')}${right < text.length ? '…' : ''}`,
  };
};

const renderSearchSnippet = (snippet) => (
  <>
    {snippet?.before || ''}
    <mark className="tldr-search-mention__highlight">{snippet?.match || ''}</mark>
    {snippet?.after || ''}
  </>
);

// Search the text that is actually visible in the selected dated edition.
// This avoids returning matches that exist only in the raw/current-or-prior
// snapshot JSON and gives us exact DOM ranges to highlight and navigate to.
const findRenderedSearchMatches = (root, query) => {
  const needle = String(query || '').trim();
  if (!root || !needle) return [];
  const documentRef = root.ownerDocument;
  const nodeFilter = documentRef.defaultView?.NodeFilter || {
    SHOW_TEXT: 4,
    FILTER_ACCEPT: 1,
    FILTER_REJECT: 2,
  };
  const tickerOnly = isTickerSearch(needle);
  const lowerNeedle = needle.toLocaleLowerCase();
  const matches = [];
  const walker = documentRef.createTreeWalker(
    root,
    nodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) => {
        const parent = node.parentElement;
        if (!parent || !node.nodeValue?.trim()) return nodeFilter.FILTER_REJECT;
        if (parent.closest('[hidden], [aria-hidden="true"], script, style')) return nodeFilter.FILTER_REJECT;
        return nodeFilter.FILTER_ACCEPT;
      },
    },
  );

  let textNode = walker.nextNode();
  while (textNode && matches.length < MAX_SEARCH_MATCHES) {
    const text = textNode.nodeValue || '';
    const lowerText = text.toLocaleLowerCase();
    let offset = 0;
    while (offset <= lowerText.length - lowerNeedle.length && matches.length < MAX_SEARCH_MATCHES) {
      const start = lowerText.indexOf(lowerNeedle, offset);
      if (start < 0) break;
      const end = start + lowerNeedle.length;
      const hasTickerBoundary = !tickerOnly
        || (!isTickerCharacter(text[start - 1]) && !isTickerCharacter(text[end]));
      if (hasTickerBoundary) {
        const range = documentRef.createRange();
        range.setStart(textNode, start);
        range.setEnd(textNode, end);
        const element = textNode.parentElement;
        const sectionId = element?.closest?.('[data-section-id]')?.dataset?.sectionId || null;
        if (element && sectionId) {
          matches.push({
            element,
            range,
            sectionId,
            snippet: searchSnippet(text, start, lowerNeedle.length),
          });
        }
      }
      offset = Math.max(end, start + 1);
    }
    textNode = walker.nextNode();
  }

  return matches;
};

const registerSearchHighlight = (name, ranges) => {
  const registry = searchHighlightRegistry();
  const HighlightConstructor = typeof window !== 'undefined' ? window.Highlight : null;
  if (!registry || typeof HighlightConstructor !== 'function') return false;
  registry.delete?.(name);
  if (ranges.length) registry.set(name, new HighlightConstructor(...ranges));
  return true;
};

const shorten = (value, limit = 1500) => {
  const text = String(value || '').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).trim()}…`;
};

// Hedgeye's email wrapper appends a signature and delivery boilerplate after
// the analyst's sign-off. Keep the stored publication intact, but stop the
// reader at the sign-off (or the first known wrapper marker when no sign-off
// was captured).
const trimHedgeyeEmailFooter = (value) => {
  const text = String(value || '');
  const kmMarker = text.match(/(?:^|\r?\n)\s*KM\s*(?=\r?\n|$)/i);
  if (kmMarker) return text.slice(0, kmMarker.index + kmMarker[0].length).trim();
  const spamMarker = text.search(/(?:\r?\n\s*)?\(\s*VIEW LARGER IMAGE\s*\)|(?:\r?\n\s*)?Please visit|(?:\r?\n\s*)?©\s*20\d{2}|(?:\r?\n\s*)?If you believe this has been sent/i);
  return spamMarker >= 0 ? text.slice(0, spamMarker).trim() : text.trim();
};

const sentenceCase = (value) => String(value || '')
  .toLowerCase()
  .replace(/\b\w/g, (letter) => letter.toUpperCase());

const trendTone = (value) => {
  const trend = String(value || '').toLowerCase();
  if (trend.includes('bull')) return 'positive';
  if (trend.includes('bear')) return 'negative';
  return 'neutral';
};

const normalizeTrendLabel = (value) => {
  const trend = String(value || '').trim();
  if (!trend) return '—';
  const normalized = trend.toLowerCase();
  if (normalized.includes('bull')) return 'BULLISH';
  if (normalized.includes('bear')) return 'BEARISH';
  if (normalized.includes('neutral')) return 'NEUTRAL';
  return trend.toUpperCase();
};

const TrendLabel = ({ value }) => (
  <span className={`tldr-wiki-trend tldr-wiki-trend--${trendTone(value)}`}>
    {normalizeTrendLabel(value)}
  </span>
);

const QUAD_WORD_NUMBERS = {
  one: '1',
  two: '2',
  three: '3',
  four: '4',
};

const QUAD_STATE_PATTERN = '(?:one|two|three|four|[1-4])';
const QUAD_SEQUENCE_PATTERN = `${QUAD_STATE_PATTERN}(?:\\s*(?:→|->|-)\\s*${QUAD_STATE_PATTERN})*`;
const QUAD_TOKEN_PATTERN = new RegExp(
  `#?\\bquad(?=\\b|[1-4])(?:\\s*(?:count\\s*(?:=|is)\\s*)?[- ]?${QUAD_SEQUENCE_PATTERN})?`,
  'gi',
);
const TREND_TOKEN_PATTERN = /\b(?:bullish|bearish|neutral)\b/gi;
const INLINE_TLDR_TOKEN_PATTERN = new RegExp(`${QUAD_TOKEN_PATTERN.source}|${TREND_TOKEN_PATTERN.source}`, 'gi');

const renderQuadToken = (token, keyPrefix, tokenIndex) => {
  const suffix = token
    .replace(/^#?\s*quad/i, '')
    .replace(/\b(one|two|three|four)\b/gi, (word) => QUAD_WORD_NUMBERS[word.toLowerCase()])
    .replace(/^\s*-\s*/, ' ');
  const suffixParts = suffix.split(/([1-4])/g);
  const firstQuad = suffix.match(/[1-4]/)?.[0] || null;
  return (
    <span className="tldr-quad-token" key={`${keyPrefix}-${tokenIndex}`}>
      <span className={`tldr-quad-word${firstQuad ? ` tldr-quad-label--${firstQuad}` : ''}`}>QUAD</span>
      {suffixParts.map((part, partIndex) => (/^[1-4]$/.test(part)
        ? <span className={`tldr-quad-label tldr-quad-label--${part}`} key={`${keyPrefix}-${tokenIndex}-${partIndex}`}>{part}</span>
        : part))}
    </span>
  );
};

// Keep Quad references on the Global Quads palette and normalize every
// bullish/bearish/neutral word in the article prose. This keeps the Macro
// Show narrative as scannable as its structured tables.
const renderInlineText = (value, keyPrefix = 'inline') => {
  const text = String(value || '');
  const parts = [];
  let cursor = 0;
  let match;
  let matchIndex = 0;
  INLINE_TLDR_TOKEN_PATTERN.lastIndex = 0;

  while ((match = INLINE_TLDR_TOKEN_PATTERN.exec(text))) {
    if (match.index > cursor) parts.push(text.slice(cursor, match.index));
    const token = match[0];
    const tokenIndex = matchIndex;
    if (/^#?\s*quad/i.test(token)) {
      parts.push(renderQuadToken(token, keyPrefix, tokenIndex));
    } else {
      parts.push(
        <span className={`tldr-wiki-trend tldr-wiki-trend--${trendTone(token)}`} key={`${keyPrefix}-${tokenIndex}`}>
          {normalizeTrendLabel(token)}
        </span>,
      );
    }
    cursor = match.index + token.length;
    matchIndex += 1;
  }

  if (!parts.length) return text;
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
};

const sideLabel = (side) => {
  if (side === 'longs') return 'Long';
  if (side === 'shorts') return 'Short';
  if (side === 'neutrals') return 'Neutral';
  return sentenceCase(side);
};

const sideTone = (side) => {
  if (side === 'longs') return 'positive';
  if (side === 'shorts') return 'negative';
  return 'neutral';
};

const normalizeOutbucket = (values) => asArray(values).map((value) => (
  value && typeof value === 'object'
    ? value.ticker || value.symbol || value.name || value.security || ''
    : value
)).filter(Boolean);

const comparableName = (value) => String(value || '').trim().toUpperCase();

const deriveTrendChanges = (snapshot, previousSnapshot) => {
  const previousByKey = new Map(getRiskRangeRows(previousSnapshot).map((row) => [
    comparableName(row.ticker || row.symbol || row.name),
    row,
  ]));
  return getRiskRangeRows(snapshot).map((row) => {
    const key = comparableName(row.ticker || row.symbol || row.name);
    const previous = previousByKey.get(key);
    if (!previous || !row.trend || !previous.trend || String(row.trend) === String(previous.trend)) return null;
    return {
      ticker: row.ticker || row.symbol || row.name,
      oldTrend: previous.trend,
      newTrend: row.trend,
    };
  }).filter(Boolean);
};

const deriveOutbucketDiff = (snapshot, previousSnapshot) => {
  const current = normalizeOutbucket(snapshot?.outbucket).map(comparableName).filter(Boolean);
  const previous = normalizeOutbucket(previousSnapshot?.outbucket).map(comparableName).filter(Boolean);
  const previousSet = new Set(previous);
  const currentSet = new Set(current);
  return {
    added: current.filter((value) => !previousSet.has(value)),
    removed: previous.filter((value) => !currentSet.has(value)),
  };
};

const buildComparison = (snapshot, previousSnapshot) => ({
  previousDate: previousSnapshot?.date || null,
  trendChanges: deriveTrendChanges(snapshot, previousSnapshot),
  outbucketDiff: deriveOutbucketDiff(snapshot, previousSnapshot),
});

const StatusPill = ({ status }) => (
  <span className={`tldr-wiki-status tldr-wiki-status--${status.tone || 'neutral'}`}>
    <span className="tldr-wiki-status__dot" aria-hidden="true" />
    {status.label}
  </span>
);

const EmptyState = ({ title, body, tone = 'neutral' }) => (
  <div className={`tldr-wiki-note tldr-wiki-note--${tone}`} role="status">
    <strong>{title}</strong>
    {body && <p>{body}</p>}
  </div>
);

const PublicationEmptyState = ({
  label,
  publicationState,
  isCurrentDate,
  historicalBody,
}) => {
  if (!isCurrentDate) {
    return (
      <EmptyState
        title={`No ${label} edition is available`}
        body={historicalBody || `No ${label} publication was saved for the selected date.`}
      />
    );
  }
  if (!publicationState) {
    return (
      <EmptyState
        title={`No ${label} edition is available yet`}
        body="No verified same-day publication is available."
      />
    );
  }
  if (publicationState === 'processing' || publicationState === 'saved' || publicationState === 'saved_update_failed') {
    return (
      <EmptyState
        title={`Preparing today's ${label}`}
        body="This section will update when the verified same-day publication is ready."
      />
    );
  }
  return (
    <EmptyState
      title={`No ${label} edition is available yet`}
      body="No verified same-day publication is available."
    />
  );
};

const PositionPills = ({ values, tone = 'neutral', limit = 24 }) => {
  const cleaned = asArray(values)
    .map(cleanPosition)
    .filter((value) => value && !/^not of any strength$/i.test(value));
  if (!cleaned.length) return <span className="process-wiki__metadata">None reported</span>;
  const visible = cleaned.slice(0, limit);
  return (
    <span className={`tldr-wiki-position-list tldr-wiki-position-list--${tone}`}>
      {visible.join(', ')}
      {cleaned.length > visible.length && ` (+${cleaned.length - visible.length} more)`}
    </span>
  );
};

const TextBlocks = ({ text, limit = 2200 }) => {
  const value = shorten(trimHedgeyeEmailFooter(text), limit);
  if (!value) return <span className="process-wiki__metadata">No source summary was captured.</span>;
  const blocks = value.split(/\n{2,}|\n(?=•)/).map((block) => block.trim()).filter(Boolean);
  return (
    <div className="tldr-wiki-text-blocks">
      {blocks.map((block, index) => <p key={`${block.slice(0, 16)}-${index}`}>{renderInlineText(block, `block-${index}`)}</p>)}
    </div>
  );
};

const SECURITY_HEADING_PATTERN = /^\s*[^\n:]+?\s+\([A-Z][A-Z0-9./-]*\)\s*:/;
const SECURITY_NAME_PATTERN = /^(\s*)([^\n:]+?\s+\([A-Z][A-Z0-9./-]*\))(?=\s*:)/;
const SECURITY_SPLIT_PATTERN = /(?=^\s*[^\n:]+?\s+\([A-Z][A-Z0-9./-]*\)\s*:)/gm;

const splitSecurityParagraphs = (text) => {
  const value = trimHedgeyeEmailFooter(text);
  if (!value) return [];
  return value
    .split(/\n{2,}|\n(?=•)/)
    .map((block) => block.trim())
    .filter(Boolean)
    .flatMap((block) => block.split(SECURITY_SPLIT_PATTERN).map((part) => part.trim()).filter(Boolean));
};

const renderSecurityBlock = (block, keyPrefix) => {
  const match = String(block || '').match(SECURITY_NAME_PATTERN);
  if (!match) return renderInlineText(block, keyPrefix);
  const [, leadingWhitespace, securityName] = match;
  return (
    <>
      {leadingWhitespace}
      <strong className="tldr-wiki-security-name">{securityName}</strong>
      {renderInlineText(block.slice(match[0].length), keyPrefix)}
    </>
  );
};

const SecurityParagraphs = ({ text, securityOnly = false, stripTopFiveBoilerplate = false, testId }) => {
  let value = String(text || '');
  if (stripTopFiveBoilerplate) {
    value = value.replace(/^\s*\(Positioning based on Hedgeye's Macro Signals, sector analysis and Signal Strength\)\s*/i, '');
  }
  const blocks = splitSecurityParagraphs(value);
  const securityBlocks = blocks.filter((block) => SECURITY_HEADING_PATTERN.test(block));
  const visibleBlocks = securityOnly && securityBlocks.length ? securityBlocks : blocks;
  if (!visibleBlocks.length) return <span className="process-wiki__metadata">No source summary was captured.</span>;
  return (
    <div className="tldr-wiki-security-blocks" data-testid={testId}>
      {visibleBlocks.map((block, index) => (
        <p className="tldr-wiki-security-block" data-testid={testId ? `${testId}-${index}` : undefined} key={`${block.slice(0, 24)}-${index}`}>
          {renderSecurityBlock(block, `security-block-${index}`)}
        </p>
      ))}
    </div>
  );
};

const EARLY_LOOK_LEVEL_LINE_PATTERN = /^.+?\s+[\d,]+(?:\.\d+)?\s*[-–—]\s*[\d,]+(?:\.\d+)?\s+\((?:bullish|bearish|neutral)\)\s*$/i;

// Early Look emails often put the levels at the end of a narrative section
// instead of giving them a dedicated parsed section. Remove those source
// lines only when normalized level rows are available; the component then
// renders the same publication once in the readable vertical list.
const splitEarlyLookLevels = (section, hasStructuredRows) => {
  if (!hasStructuredRows) return { ...section, footer: '' };
  const titleHasLevels = /^our levels$/i.test(String(section.title || '').trim());
  const marker = String(section.body || '').match(/\bour levels\b/i);
  if (!titleHasLevels && !marker) return { ...section, footer: '' };

  const source = trimHedgeyeEmailFooter(section.body);
  const bodyStart = titleHasLevels ? '' : source.slice(0, marker.index).trim();
  const levelsStart = titleHasLevels
    ? source
    : source.slice(marker.index + marker[0].length).trim();
  const lines = levelsStart.split(/\r?\n/);
  const levelLines = lines.filter((line) => EARLY_LOOK_LEVEL_LINE_PATTERN.test(line.trim()));
  if (!levelLines.length) return { ...section, footer: '' };

  const footer = lines
    .filter((line) => !EARLY_LOOK_LEVEL_LINE_PATTERN.test(line.trim()))
    .join('\n')
    .trim();
  return {
    ...section,
    body: bodyStart,
    footer,
  };
};

const ChangeColumns = ({ added = [], removed = [], moved = [] }) => {
  const hasChanges = added.length || removed.length || moved.length;
  if (!hasChanges) return <p className="process-wiki__metadata">No explicit changes in the prior comparison.</p>;
  return (
    <dl className="tldr-wiki-change-list">
      <dt className="tldr-wiki-position-label tldr-wiki-position-label--positive">Added</dt>
      <dd><PositionPills values={added.map((item) => item.value || item)} tone="positive" /></dd>
      <dt className="tldr-wiki-position-label tldr-wiki-position-label--negative">Removed</dt>
      <dd><PositionPills values={removed.map((item) => item.value || item)} tone="negative" /></dd>
      {moved.length > 0 && (
        <>
          <dt>Side changes</dt>
          <dd>
            {moved.map((item, index) => (
              <span className="tldr-wiki-change-item" key={`${item.value}-${item.from}-${item.to}`}>
                {index > 0 && ', '}
                <span className={`tldr-wiki-position-list--${sideTone(item.to)}`}>{item.value}</span>
                : <span className={`tldr-wiki-position-list--${sideTone(item.from)}`}>{sideLabel(item.from)}</span>
                <span aria-hidden="true"> → </span>
                <span className={`tldr-wiki-position-list--${sideTone(item.to)}`}>{sideLabel(item.to)}</span>
              </span>
            ))}
          </dd>
        </>
      )}
    </dl>
  );
};

const signalPercent = (value) => {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const parsed = Number(value);
  return `${parsed > 0 ? '+' : ''}${parsed.toFixed(1)}%`;
};

const SignalStrengthTable = ({ stocks = [] }) => (
  <div className="tldr-wiki-table-scroll">
    <table
      className="wp-table tldr-wiki-table tldr-wiki-signal-table"
      aria-label="Signal Strength securities"
      data-testid="signal-strength-table"
    >
      <thead>
        <tr>
          <th scope="col">Days On</th>
          <th scope="col">Ticker</th>
          <th scope="col">% Change Since Signal</th>
        </tr>
      </thead>
      <tbody>
        {stocks.map((stock) => {
          const percent = stock.percentChangeSinceSignal;
          const tone = percent == null || percent === 0 ? 'neutral' : percent > 0 ? 'positive' : 'negative';
          return (
            <tr key={stock.ticker} data-key={stock.ticker} data-testid={`signal-strength-row-${stock.ticker}`}>
              <td>{stock.daysOn == null ? '—' : formatNumber(stock.daysOn, 0)}</td>
              <th scope="row">{stock.ticker}</th>
              <td className={`tldr-wiki-number--${tone}`}>{signalPercent(percent)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  </div>
);

const signedDelta = (value) => (
  value == null ? '-' : `${value >= 0 ? '+' : ''}${formatNumber(value)}`
);

const deltaTone = (value) => {
  if (value == null || value === 0) return 'neutral';
  return value > 0 ? 'positive' : 'negative';
};

const signedPercent = (value) => {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
};

const formatRatioValue = (value) => {
  if (!Number.isFinite(value)) return '—';
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
};

const RiskComparisonRatio = ({ row }) => {
  const rangePercents = computeRiskRangePercents(row.prevClose, row.lrr, row.hrr);
  const downside = Math.abs(rangePercents?.downsidePct ?? NaN);
  const upside = Math.abs(rangePercents?.upsidePct ?? NaN);

  if (!Number.isFinite(downside) || !Number.isFinite(upside) || upside === 0) return null;

  const ratio = downside / upside;
  const ratioLabel = `${formatRatioValue(ratio)} to 1`;
  return (
    <span
      className="tldr-wiki-risk-ratio"
      data-testid={`risk-reward-ratio-${row.key}`}
      aria-label={`Downside to upside ratio ${ratioLabel}`}
    >
      <span className="tldr-wiki-risk-ratio__downside">{formatRatioValue(ratio)}</span>{' '}
      <span className="tldr-wiki-risk-ratio__separator" aria-hidden="true">:</span>
      {' '}<span className="tldr-wiki-risk-ratio__upside">1</span>
    </span>
  );
};

const TrendOrDash = ({ value }) => (
  value ? <TrendLabel value={value} /> : <span className="process-wiki__metadata">-</span>
);

const RiskComparisonTrend = ({ row }) => {
  let bias;
  if (row.state === 'trend-change') {
    bias = <><TrendOrDash value={row.priorTrend} /><span aria-hidden="true"> → </span><TrendOrDash value={row.currentTrend} /></>;
  } else if (row.state === 'added') {
    bias = <TrendOrDash value={row.currentTrend} />;
  } else if (row.state === 'removed') {
    bias = (
      <>
        <span aria-label="No current trend">—</span>
        <small className="tldr-wiki-prior-value">Prior {row.priorTrend ? <TrendLabel value={row.priorTrend} /> : '—'}</small>
      </>
    );
  } else {
    bias = <TrendOrDash value={row.currentTrend || row.trend} />;
  }

  return (
    <span className="tldr-wiki-risk-trend">
      <span className="tldr-wiki-risk-trend__bias">{bias}</span>
      <RiskComparisonRatio row={row} />
    </span>
  );
};

const RiskComparisonLevel = ({ row, field, priorField, deltaField }) => {
  if (row.state === 'removed') {
    return <><span aria-label={`No current ${field.toUpperCase()}`}>—</span><small className="tldr-wiki-prior-value">Prior {formatNumber(row[priorField])}</small></>;
  }
  if (row[field] == null || (typeof row[field] === 'string' && !row[field].trim())) {
    return <span aria-label={`${field.toUpperCase()} not reported`}>—</span>;
  }
  const secondary = row.state === 'added'
    ? 'NEW'
    : row.state === 'uncompared'
      ? '-'
      : signedDelta(row[deltaField]);
  const rangePercents = computeRiskRangePercents(row.prevClose, row.lrr, row.hrr);
  const percent = field === 'lrr' ? rangePercents?.downsidePct : rangePercents?.upsidePct;
  const trendClass = `tldr-wiki-trend--${trendTone(row.currentTrend || row.trend)}`;
  return (
    <span className="tldr-wiki-risk-level" data-testid={`risk-level-${row.key}-${field}`}>
      <span className={`tldr-wiki-risk-level__value ${trendClass}`}>{formatNumber(row[field])}</span>
      <span className="tldr-wiki-risk-level__footer" data-testid={`risk-level-footer-${row.key}-${field}`}>
        <small className={`tldr-wiki-risk-level__delta tldr-wiki-number--${deltaTone(row[deltaField])}`}>{secondary}</small>
        {Number.isFinite(percent) && (
          <small className={`tldr-wiki-risk-level__percent tldr-wiki-number--${deltaTone(percent)}`}>{signedPercent(percent)}</small>
        )}
      </span>
    </span>
  );
};

const getRiskRangeClosePlacement = (row) => {
  if (
    row?.prevClose == null
    || row?.lrr == null
    || row?.hrr == null
    || row.prevClose === ''
    || row.lrr === ''
    || row.hrr === ''
  ) return null;

  const close = Number(row.prevClose);
  const low = Number(row.lrr);
  const high = Number(row.hrr);
  if (![close, low, high].every(Number.isFinite) || high <= low) return null;

  const rawPosition = ((close - low) / (high - low)) * 100;
  const position = Math.max(0, Math.min(100, rawPosition));
  const description = rawPosition < 0
    ? 'below the published Risk Range'
    : rawPosition > 100
      ? 'above the published Risk Range'
      : `${Math.round(position)}% through the published Risk Range`;
  return { position, description };
};

const RiskComparisonClose = ({ row }) => {
  if (row.state === 'removed') {
    return (
      <>
        <span aria-label="No current closing price">—</span>
        <small className="tldr-wiki-prior-value">Prior {formatNumber(row.priorPrevClose)}</small>
      </>
    );
  }
  const placement = getRiskRangeClosePlacement(row);
  const closeLabel = formatNumber(row.prevClose);
  return (
    <span
      className="tldr-wiki-risk-close"
      data-range-position={placement ? placement.position.toFixed(1) : undefined}
      data-testid={`risk-close-${row.key}`}
      style={placement ? { '--tldr-risk-close-position': `${placement.position}%` } : undefined}
    >
      <span
        className="tldr-wiki-risk-close__value"
        aria-label={`Prior close ${closeLabel}${placement ? `, ${placement.description}` : ', Risk Range position unavailable'}`}
      >
        {closeLabel}
      </span>
    </span>
  );
};

const RISK_RANGE_SORT_OPTIONS = [
  { id: 'largestMovePct', label: 'Actionable', description: 'largest move' },
  { id: 'upsidePct', label: 'Upside', description: 'largest upside' },
  { id: 'downsidePct', label: 'Downside', description: 'largest downside' },
];

const sortRiskRangeRows = (rows, sortKey) => rows
  .map((row, index) => ({
    row,
    index,
    metrics: row.state === 'removed'
      ? null
      : computeRiskRangeActionability(row.prevClose, row.lrr, row.hrr),
  }))
  .sort((left, right) => {
    const leftValue = left.metrics?.[sortKey];
    const rightValue = right.metrics?.[sortKey];
    const leftAvailable = Number.isFinite(leftValue);
    const rightAvailable = Number.isFinite(rightValue);
    if (leftAvailable !== rightAvailable) return rightAvailable ? 1 : -1;
    if (leftAvailable && rightValue !== leftValue) return rightValue - leftValue;
    return left.index - right.index;
  })
  .map(({ row }) => row);

const RiskComparisonTable = ({ rows, closeDate }) => {
  const [sortOptionIndex, setSortOptionIndex] = useState(0);
  const sortOption = RISK_RANGE_SORT_OPTIONS[sortOptionIndex];
  const nextSortOption = RISK_RANGE_SORT_OPTIONS[(sortOptionIndex + 1) % RISK_RANGE_SORT_OPTIONS.length];
  const sortedRows = useMemo(
    () => sortRiskRangeRows(rows, sortOption.id),
    [rows, sortOption.id],
  );
  const closeLabel = `Prior close${closeDate ? ` (${closeDate})` : ''}`;
  return (
    <div className="tldr-wiki-table-scroll">
      <table className="wp-table tldr-wiki-table tldr-wiki-comparison-table" aria-label="Risk Range comparison" data-testid="risk-comparison-table">
        <thead>
          <tr>
            <th scope="col">Instrument</th>
            <th scope="col">Trend</th>
            <th scope="col">LRR</th>
            <th scope="col" aria-sort="descending">
              <button
                type="button"
                className="tldr-wiki-risk-sort"
                aria-label={`${closeLabel}. Sorted by ${sortOption.description}, descending. Select to sort by ${nextSortOption.description}.`}
                title={`Sorted by ${sortOption.description}. Click for ${nextSortOption.description}.`}
                onClick={() => setSortOptionIndex((current) => (current + 1) % RISK_RANGE_SORT_OPTIONS.length)}
              >
                <span>{closeLabel}</span>
                <small>{sortOption.label}<span aria-hidden="true"> ↓</span></small>
              </button>
            </th>
            <th scope="col">HRR</th>
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row) => (
            <tr
              className={`tldr-wiki-comparison-row tldr-wiki-comparison-row--${row.state}`}
              data-key={row.key}
              data-state={row.state}
              data-testid={`risk-comparison-row-${row.key}`}
              key={`${row.state}-${row.key}`}
            >
              <th scope="row" title={row.originalName}>{row.key}</th>
              <td><RiskComparisonTrend row={row} /></td>
              <td><RiskComparisonLevel row={row} field="lrr" priorField="priorLrr" deltaField="lrrDelta" /></td>
              <td><RiskComparisonClose row={row} /></td>
              <td><RiskComparisonLevel row={row} field="hrr" priorField="priorHrr" deltaField="hrrDelta" /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const RiskChanges = ({ riskComparison = {}, outbucketDiff, outbucket = [], closeDate }) => {
  const rows = asArray(riskComparison.rows);
  const addedOut = normalizeOutbucket(outbucketDiff?.added);
  const removedOut = normalizeOutbucket(outbucketDiff?.removed);
  const currentOutbucket = normalizeOutbucket(outbucket);
  if (!rows.length && !addedOut.length && !removedOut.length && !currentOutbucket.length) {
    return <p className="process-wiki__metadata">No material range changes were reported.</p>;
  }
  return (
    <>
      {!riskComparison.hasPrevious && rows.length > 0 && <p className="process-wiki__metadata">No prior Risk Ranges edition is available; current rows are shown without inferred changes.</p>}
      {rows.length > 0 && <RiskComparisonTable rows={rows} closeDate={closeDate} />}
      {(addedOut.length > 0 || removedOut.length > 0) && (
        <div className="tldr-wiki-subsection">
          <h4>OutBucket changes</h4>
          <ChangeColumns added={addedOut} removed={removedOut} />
        </div>
      )}
      {currentOutbucket.length > 0 && (
        <p className="tldr-wiki-source-line"><strong>Latest OutBucket:</strong> <PositionPills values={currentOutbucket} tone="negative" /></p>
      )}
    </>
  );
};

const SourceMeta = ({ snapshot }) => (
  <p className="process-wiki__metadata tldr-wiki-source-meta">
    <span>{snapshot ? snapshotLabel(snapshot) : 'No edition'}</span>
    {snapshot?.publishedAt && <span> · Published {formatTimestamp(snapshot.publishedAt)}</span>}
    {snapshot?.scrapedAt && <span> · Retrieved {formatTimestamp(snapshot.scrapedAt)}</span>}
    {snapshot?.article?.feedUrl && <a href={snapshot.article.feedUrl} target="_blank" rel="noreferrer"> · Open source</a>}
  </p>
);

const SectionHeader = ({ title, description, sourceStatus, snapshot }) => (
  <header className="tldr-wiki-section-header">
    <div className="tldr-wiki-section-heading-row">
      <h2>{title} <StatusPill status={sourceStatus} /></h2>
      <SourceMeta snapshot={snapshot} />
    </div>
    {description && <p>{description}</p>}
  </header>
);

const TopThreeThingsSection = ({ snapshot, publicationState, isCurrentDate }) => {
  const items = getTopThreeThings(snapshot);
  const intro = String(snapshot?.data?.intro || '').trim();
  return (
    <>
      {!snapshot && (
        <PublicationEmptyState
          label="Top 3 Things"
          publicationState={publicationState}
          isCurrentDate={isCurrentDate}
          historicalBody="No exact-date Top 3 Things publication was saved for the selected date."
        />
      )}
      {snapshot && items.length !== 3 && <EmptyState title="Top 3 Things is incomplete" body="The source publication did not contain all three numbered items, so no missing item is inferred." />}
      {snapshot && items.length === 3 && (
        <>
          {intro && <p className="tldr-wiki-top-three-intro">{renderInlineText(intro, 'top-three-intro')}</p>}
          <ol className="tldr-wiki-top-three" data-testid="top-three-things-list">
            {items.map((item) => (
              <li value={item.rank} key={`${item.rank}-${item.title}`}>
                <h3>{renderInlineText(item.title, `top-three-title-${item.rank}`)}</h3>
                <TextBlocks text={item.body} />
              </li>
            ))}
          </ol>
        </>
      )}
    </>
  );
};

const RiskRangesSection = ({
  snapshot,
  previousSnapshot,
  comparison = {},
  publicationState,
  isCurrentDate,
}) => {
  const riskComparison = buildRiskRangeComparison(snapshot, previousSnapshot, comparison);
  return (
    <>
      {!snapshot && (
        <PublicationEmptyState
          label="Risk Ranges"
          publicationState={publicationState}
          isCurrentDate={isCurrentDate}
          historicalBody="No exact-date Risk Ranges publication was saved. Older levels are not substituted."
        />
      )}
      {snapshot && (
        <>
          <RiskChanges
            riskComparison={riskComparison}
            outbucketDiff={comparison?.outbucketDiff}
            outbucket={snapshot.outbucket}
            closeDate={previousSnapshot ? snapshotLabel(previousSnapshot) : null}
          />
        </>
      )}
    </>
  );
};

const EarlyLookSection = ({
  snapshot,
  previousSnapshot,
  comparison = {},
  publicationState,
  isCurrentDate,
}) => {
  const takeaways = articleTakeaways(snapshot);
  const rows = getRiskRangeRows(snapshot);
  const levelAwareSections = articleSections(snapshot)
    .filter((section) => !/^key takeaways$/i.test(section.title))
    .map((section) => splitEarlyLookLevels(section, rows.length > 0));
  const sections = levelAwareSections.filter((section) => (
    !/^our levels$/i.test(section.title) && section.body
  ));
  const levelFooter = levelAwareSections
    .map((section) => section.footer)
    .filter(Boolean)
    .join('\n\n');
  const trendChanges = asArray(comparison?.trendChanges);
  return (
    <>
      {!snapshot && (
        <PublicationEmptyState
          label="Early Look"
          publicationState={publicationState}
          isCurrentDate={isCurrentDate}
          historicalBody="No exact-date Early Look publication was saved for the selected date."
        />
      )}
      {snapshot && (
        <>
          {takeaways.length > 0 && <><h3>Key takeaways</h3><ul>{takeaways.slice(0, 6).map((item) => <li key={item}>{renderInlineText(trimHedgeyeEmailFooter(item), 'takeaway')}</li>)}</ul></>}
          {trendChanges.length > 0 && (
            <>
              <h3>Trend changes vs {previousSnapshot ? snapshotLabel(previousSnapshot) : 'prior publication'}</h3>
              <ul>{trendChanges.map((change) => <li key={`${change.ticker}-${change.newTrend}`}><strong>{change.ticker}</strong>: <TrendLabel value={change.oldTrend} /> → <TrendLabel value={change.newTrend} /></li>)}</ul>
            </>
          )}
          {sections.slice(0, 5).map((section) => <React.Fragment key={section.title}><h3>{renderInlineText(section.title, 'early-heading')}</h3><TextBlocks text={section.body} /></React.Fragment>)}
          {rows.length > 0 && (
            <>
              <h3>Our Levels</h3>
              <ul className="tldr-wiki-level-list" data-testid="early-look-levels">
                {rows.map((row) => {
                  const name = row.originalName || row.name || row.ticker || row.symbol || 'Instrument';
                  const low = formatNumber(row.lrr);
                  const high = formatNumber(row.hrr);
                  const range = low === '—' && high === '—' ? '—' : `${low}-${high}`;
                  return (
                    <li className="tldr-wiki-level-list__item" key={row.ticker || row.symbol || row.name}>
                      <span>{name} </span>
                      <span className="tldr-wiki-level-list__range">{range}</span>
                      <span> (</span><TrendLabel value={row.trend} /><span>)</span>
                    </li>
                  );
                })}
              </ul>
              {levelFooter && <TextBlocks text={levelFooter} />}
            </>
          )}
        </>
      )}
    </>
  );
};

const PositionSection = ({
  productId,
  snapshot,
  previousSnapshot,
  publicationState,
  isCurrentDate,
}) => {
  const groups = getPositionGroups(snapshot);
  const previousGroups = getPositionGroups(previousSnapshot);
  const snapshotDiff = diffPositionGroups(snapshot, previousSnapshot);
  const explicitAdded = [];
  const explicitRemoved = [];
  const sections = articleSections(snapshot);
  const summary = snapshot?.article?.summary;
  const selectedSections = productId === 'the-call'
    ? sections.filter((section) => /top 5|macro commentary|sector summary/i.test(section.title)).slice(0, 4)
    : summary
      ? sections.filter((section) => /key takeaway/i.test(section.title)).slice(0, 2)
      : sections.filter((section) => /main summary|position changes|macro|summary/i.test(section.title)).slice(0, 3);
  const added = explicitAdded.length ? explicitAdded : snapshotDiff.added;
  const removed = explicitRemoved.length ? explicitRemoved : snapshotDiff.removed;
  const moved = snapshotDiff.moved;
  const total = groups.longs.length + groups.shorts.length + groups.neutrals.length;
  const label = productId === 'the-call' ? 'Call' : 'Macro Show';
  return (
    <>
      {!snapshot && (
        <PublicationEmptyState
          label={label}
          publicationState={publicationState}
          isCurrentDate={isCurrentDate}
          historicalBody="The last available publication is never relabeled as the selected date's edition."
        />
      )}
      {snapshot && (
        <>
          <h3>Positioning for this date</h3>
          <p>{total} source-listed positions: <strong className="tldr-wiki-position-label--positive">{groups.longs.length} long</strong>, <strong className="tldr-wiki-position-label--negative">{groups.shorts.length} short</strong>, and <strong className="tldr-wiki-position-label--neutral">{groups.neutrals.length} neutral</strong>.</p>
          <dl className="tldr-wiki-position-groups">
            <dt className="tldr-wiki-position-label tldr-wiki-position-label--positive">Long</dt><dd><PositionPills values={groups.longs} tone="positive" /></dd>
            <dt className="tldr-wiki-position-label tldr-wiki-position-label--negative">Short</dt><dd><PositionPills values={groups.shorts} tone="negative" /></dd>
            <dt className="tldr-wiki-position-label tldr-wiki-position-label--neutral">Neutral</dt><dd><PositionPills values={groups.neutrals} tone="neutral" /></dd>
          </dl>
          <h3>What changed vs {previousSnapshot ? snapshotLabel(previousSnapshot) : 'prior publication'}</h3>
          <ChangeColumns added={added} removed={removed} moved={moved} />
          {summary && <><h3>Source summary</h3><TextBlocks text={summary} /></>}
          {selectedSections.map((section) => {
            const isTopFive = productId === 'the-call' && /^top 5 most actionable$/i.test(section.title);
            const isSectorSummary = productId === 'the-call' && /^sector summary$/i.test(section.title);
            return (
              <React.Fragment key={section.title}>
                <h3>{renderInlineText(section.title, 'position-heading')}</h3>
                {isTopFive
                  ? <SecurityParagraphs text={section.body} securityOnly stripTopFiveBoilerplate testId="tldr-top-five-security-blocks" />
                  : isSectorSummary
                    ? <SecurityParagraphs text={section.body} testId="tldr-sector-security-blocks" />
                    : <TextBlocks text={section.body} />}
              </React.Fragment>
            );
          })}
          {!summary && !selectedSections.length && <TextBlocks text={snapshot.article?.bodyText} limit={1800} />}
          {previousGroups.longs.length + previousGroups.shorts.length + previousGroups.neutrals.length === 0 && explicitAdded.length === 0 && explicitRemoved.length === 0 && <p className="process-wiki__metadata">No prior same-product edition was available for a comparison.</p>}
        </>
      )}
    </>
  );
};

const SignalStrengthSection = ({ snapshot, publicationState, isCurrentDate }) => {
  const changes = getSignalChanges(snapshot);
  const label = 'Signal Strength';
  return (
    <>
      {!snapshot && (
        <PublicationEmptyState
          label={label}
          publicationState={publicationState}
          isCurrentDate={isCurrentDate}
          historicalBody={`${label} can publish more than once in a day; no exact-date edition was saved for the selected date.`}
        />
      )}
      {snapshot && (
        <>
          {(changes.added.length > 0 || changes.removed.length > 0) && (
            <ChangeColumns added={changes.added} removed={changes.removed} />
          )}
          {changes.membershipComplete && changes.stocks.length > 0 && <SignalStrengthTable stocks={changes.stocks} />}
        </>
      )}
    </>
  );
};

const formatDateTab = (date) => {
  if (!date) return 'Date unavailable';
  const parsed = new Date(`${date}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' });
};

const formatDateLong = (date) => {
  if (!date) return 'Date unavailable';
  const parsed = new Date(`${date}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'long', day: 'numeric', year: 'numeric' });
};

const isExactDateEdition = (edition, date) => {
  if (!edition || edition.date !== date) return false;
  return Object.values(edition.snapshots || {}).every((snapshot) => (
    !snapshot || snapshot.date === date
  ));
};

const browserDocumentIsVisible = () => (
  typeof document === 'undefined' || !document.hidden
);

const MorningTldrPanel = () => {
  const active = useSurfaceActivity();
  const [archiveDates, setArchiveDates] = useState([]);
  const [selectedDate, setSelectedDate] = useState(null);
  const [dayData, setDayData] = useState(null);
  const [archiveLoading, setArchiveLoading] = useState(true);
  const [dayLoading, setDayLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [publicationStatus, setPublicationStatus] = useState(null);
  const [statusCheckedAt, setStatusCheckedAt] = useState(null);
  const [statusError, setStatusError] = useState(null);
  const [activeSection, setActiveSection] = useState('top-3-things');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchIndex, setSearchIndex] = useState({ query: '', matches: [] });
  const [activeSearchMatch, setActiveSearchMatch] = useState(-1);
  const [searchResultsOpen, setSearchResultsOpen] = useState(false);
  const marketStructureReport = useMarketStructureReport({
    active: active && Boolean(selectedDate),
    date: selectedDate,
  });
  const contentRef = useRef(null);
  const sectionRefs = useRef({});
  const searchMatchRefs = useRef([]);
  const requestSequenceRef = useRef(0);
  const statusSequenceRef = useRef(0);
  const activeRef = useRef(active);
  const selectedDateRef = useRef(null);
  const dayDataRef = useRef(null);
  const contentRevisionRef = useRef(null);
  const archiveInitializedRef = useRef(false);
  const dayCacheRef = useRef(new Map());

  useEffect(() => {
    activeRef.current = active;
    if (!active) {
      requestSequenceRef.current += 1;
      statusSequenceRef.current += 1;
    }
  }, [active]);

  const loadDay = useCallback(async (date, requestSequence, {
    retainExisting = false,
    allowEmpty = false,
    force = false,
  } = {}) => {
    if (!date) return false;
    setDayLoading(true);
    try {
      const result = force
        ? await MarketDataService.getMorningTldrDay(date, { force: true })
        : await MarketDataService.getMorningTldrDay(date);
      if (requestSequence !== requestSequenceRef.current || !activeRef.current) return false;
      if (result) {
        if (!isExactDateEdition(result, date)) {
          const exactDateError = new Error('The TL;DR service returned content from a different date.');
          exactDateError.code = 'TLDR_CROSS_DATE_RESPONSE';
          throw exactDateError;
        }
        dayCacheRef.current.set(date, result);
        dayDataRef.current = result;
        setDayData(result);
        setError(null);
        setStatusError((current) => (current?.kind === 'content' ? null : current));
        return true;
      }
      if (retainExisting && dayDataRef.current?.date === date) {
        setStatusError({
          kind: 'content',
          message: `The refreshed ${formatDateLong(date)} edition was unavailable; the verified exact-date edition remains displayed.`,
        });
        return false;
      }
      dayDataRef.current = null;
      setDayData(null);
      if (allowEmpty) {
        setError(null);
        return true;
      } else {
        setError(`No saved TL;DR edition is available for ${formatDateLong(date)}.`);
        return false;
      }
    } catch (loadError) {
      if (requestSequence !== requestSequenceRef.current || !activeRef.current) return false;
      const message = loadError?.message || `Unable to load the ${formatDateLong(date)} edition.`;
      if (retainExisting && dayDataRef.current?.date === date) {
        setStatusError({ kind: 'content', message });
      } else {
        dayDataRef.current = null;
        setDayData(null);
        setError(message);
      }
      return false;
    } finally {
      if (requestSequence === requestSequenceRef.current && activeRef.current) setDayLoading(false);
    }
  }, []);

  const loadStatus = useCallback(async (date, {
    refreshOnRevision = false,
    adoptRevision = true,
    force = false,
  } = {}) => {
    if (!date) return false;
    const statusSequence = ++statusSequenceRef.current;
    try {
      const result = force
        ? await MarketDataService.getMorningTldrStatus(date, { force: true })
        : await MarketDataService.getMorningTldrStatus(date);
      if (
        statusSequence !== statusSequenceRef.current
        || !activeRef.current
        || selectedDateRef.current !== date
      ) return false;
      if (
        result?.date !== date
        || typeof result?.contentRevision !== 'string'
        || !result?.products
      ) {
        throw new Error('The TL;DR publication-status response was invalid.');
      }

      const checkedAt = new Date().toISOString();
      const previousRevision = contentRevisionRef.current;
      setPublicationStatus(result);
      setStatusCheckedAt(checkedAt);
      setStatusError((current) => (current?.kind === 'content' ? current : null));

      const savedProductIds = Object.entries(result.products)
        .filter(([, product]) => (
          product?.state === 'saved' || product?.state === 'saved_update_failed'
        ))
        .map(([productId]) => productId);
      const reportsSavedContent = savedProductIds.length > 0;
      const localEditionCoversSavedProducts = savedProductIds.every((productId) => (
        dayDataRef.current?.date === date
        && dayDataRef.current?.snapshots?.[productId]?.date === date
      ));
      const shouldRefreshContent = !localEditionCoversSavedProducts || (
        refreshOnRevision && (
          (previousRevision && previousRevision !== result.contentRevision)
          || (!previousRevision && reportsSavedContent)
        )
      );
      if (shouldRefreshContent) {
        const requestSequence = ++requestSequenceRef.current;
        const loaded = await loadDay(date, requestSequence, {
          retainExisting: true,
          allowEmpty: !reportsSavedContent,
        });
        const refreshedEditionCoversSavedProducts = savedProductIds.every((productId) => (
          dayDataRef.current?.date === date
          && dayDataRef.current?.snapshots?.[productId]?.date === date
        ));
        if (
          loaded
          && refreshedEditionCoversSavedProducts
          && statusSequence === statusSequenceRef.current
          && selectedDateRef.current === date
        ) {
          contentRevisionRef.current = result.contentRevision;
          setStatusError(null);
          return true;
        }
        if (statusSequence === statusSequenceRef.current && selectedDateRef.current === date) {
          setStatusError({
            kind: 'content',
            message: 'A saved exact-date publication update could not be loaded. The last verified exact-date edition remains displayed.',
          });
        }
        return false;
      }
      if (adoptRevision) {
        contentRevisionRef.current = result.contentRevision;
        setStatusError(null);
      }
      return true;
    } catch (loadError) {
      if (
        statusSequence !== statusSequenceRef.current
        || !activeRef.current
        || selectedDateRef.current !== date
      ) return false;
      setStatusCheckedAt(new Date().toISOString());
      setStatusError((current) => (current?.kind === 'content' ? current : {
        kind: 'status',
        message: loadError?.message || 'Unable to check current TL;DR publication status.',
      }));
      return false;
    }
  }, [loadDay]);

  const loadArchive = useCallback(async () => {
    const requestSequence = ++requestSequenceRef.current;
    setArchiveLoading(true);
    setError(null);
    try {
      const result = await MarketDataService.getMorningTldrArchive();
      if (requestSequence !== requestSequenceRef.current || !activeRef.current) return;
      const dates = asArray(result?.dates)
        .map((entry) => (typeof entry === 'string' ? { date: entry, availableProducts: [], missingProducts: PRODUCT_IDS } : entry))
        .filter((entry) => entry?.date);
      const nextDate = dates[0]?.date || result?.latestDate || null;
      setArchiveDates(dates);
      selectedDateRef.current = nextDate;
      setSelectedDate(nextDate);
      setActiveSection('top-3-things');
      setSearchQuery('');
      dayDataRef.current = null;
      setDayData(null);
      setPublicationStatus(null);
      setStatusCheckedAt(null);
      setStatusError(null);
      contentRevisionRef.current = null;
      if (nextDate) {
        await loadDay(nextDate, requestSequence, { allowEmpty: nextDate === todayInNewYork() });
        if (
          requestSequence === requestSequenceRef.current
          && activeRef.current
          && nextDate === todayInNewYork()
          && browserDocumentIsVisible()
        ) await loadStatus(nextDate);
      }
      if (requestSequence === requestSequenceRef.current && activeRef.current) {
        archiveInitializedRef.current = true;
      }
    } catch (loadError) {
      if (requestSequence !== requestSequenceRef.current || !activeRef.current) return;
      setArchiveDates([]);
      setSelectedDate(null);
      setDayData(null);
      setError(loadError?.message || 'Unable to load the saved Morning TL;DR dates.');
    } finally {
      if (requestSequence === requestSequenceRef.current && activeRef.current) {
        setArchiveLoading(false);
      }
    }
  }, [loadDay, loadStatus]);

  const refreshTldr = useCallback(async () => {
    if (!activeRef.current || refreshing) return;
    const date = selectedDateRef.current;
    const requestSequence = ++requestSequenceRef.current;
    dayCacheRef.current.clear();
    setRefreshing(true);
    setError(null);

    const refreshArchive = async () => {
      try {
        const result = await MarketDataService.getMorningTldrArchive({ force: true });
        if (requestSequence !== requestSequenceRef.current || !activeRef.current) return;
        const dates = asArray(result?.dates)
          .map((entry) => (typeof entry === 'string' ? { date: entry, availableProducts: [], missingProducts: PRODUCT_IDS } : entry))
          .filter((entry) => entry?.date);
        setArchiveDates((currentDates) => {
          if (!date || dates.some((entry) => entry.date === date)) return dates;
          const selectedEntry = currentDates.find((entry) => entry.date === date) || {
            date,
            availableProducts: [],
            missingProducts: PRODUCT_IDS,
          };
          return [...dates, selectedEntry]
            .sort((left, right) => right.date.localeCompare(left.date));
        });
      } catch (loadError) {
        if (requestSequence !== requestSequenceRef.current || !activeRef.current) return;
        setStatusError((current) => (current?.kind === 'content' ? current : {
          kind: 'archive',
          message: loadError?.message || 'Unable to refresh the saved TL;DR date index.',
        }));
      }
    };
    const refreshEditionAndStatus = async () => {
      if (!date) return;
      const loaded = await loadDay(date, requestSequence, {
        retainExisting: true,
        allowEmpty: date === todayInNewYork(),
        force: true,
      });
      await loadStatus(date, { adoptRevision: loaded, force: true });
    };

    if (date) marketStructureReport.refresh();
    await Promise.allSettled([refreshArchive(), refreshEditionAndStatus()]);
    if (requestSequence === requestSequenceRef.current && activeRef.current) setRefreshing(false);
  }, [loadDay, loadStatus, marketStructureReport, refreshing]);

  useEffect(() => {
    if (!active) return;
    if (!archiveInitializedRef.current) {
      loadArchive();
    }
  }, [active, loadArchive]);

  const selectDate = useCallback((date) => {
    if (!date || date === selectedDate) return;
    const requestSequence = ++requestSequenceRef.current;
    statusSequenceRef.current += 1;
    selectedDateRef.current = date;
    setSelectedDate(date);
    setActiveSection('top-3-things');
    setSearchQuery('');
    setError(null);
    setPublicationStatus(null);
    setStatusCheckedAt(null);
    setStatusError(null);
    contentRevisionRef.current = null;
    const cached = dayCacheRef.current.get(date);
    if (cached) {
      dayDataRef.current = cached;
      setDayData(cached);
      setDayLoading(false);
      if (date === todayInNewYork() && browserDocumentIsVisible()) {
        loadStatus(date, { refreshOnRevision: true });
      }
      return;
    }
    dayDataRef.current = null;
    setDayData(null);
    loadDay(date, requestSequence, { allowEmpty: date === todayInNewYork() })
      .then(() => {
        if (
          selectedDateRef.current === date
          && date === todayInNewYork()
          && browserDocumentIsVisible()
        ) loadStatus(date);
      });
  }, [loadDay, loadStatus, selectedDate]);

  useEffect(() => {
    if (
      !active
      || archiveLoading
      || !selectedDate
      || selectedDate !== todayInNewYork()
    ) return undefined;
    const checkedAtMs = Date.parse(String(statusCheckedAt || ''));
    const elapsedMs = Number.isFinite(checkedAtMs) ? Date.now() - checkedAtMs : Infinity;
    const initialDelayMs = Number.isFinite(elapsedMs)
      ? Math.max(0, TLDR_STATUS_POLL_INTERVAL_MS - elapsedMs)
      : 0;
    if (initialDelayMs <= 0) {
      loadStatus(selectedDate, { refreshOnRevision: true });
    }
    return startVisibilityAwarePolling({
      poll: () => loadStatus(selectedDate, { refreshOnRevision: true }),
      intervalMs: TLDR_STATUS_POLL_INTERVAL_MS,
      initialDelayMs: initialDelayMs <= 0 ? TLDR_STATUS_POLL_INTERVAL_MS : initialDelayMs,
    });
  }, [active, archiveLoading, loadStatus, selectedDate, statusCheckedAt]);

  const handleDateKeyDown = useCallback((event, date) => {
    const index = archiveDates.findIndex((entry) => entry.date === date);
    if (index < 0) return;
    let nextIndex = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = Math.min(archiveDates.length - 1, index + 1);
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = Math.max(0, index - 1);
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = archiveDates.length - 1;
    if (nextIndex == null || nextIndex === index) return;
    event.preventDefault();
    const nextDate = archiveDates[nextIndex]?.date;
    selectDate(nextDate);
    event.currentTarget.parentElement?.querySelectorAll?.('[role="tab"]')?.[nextIndex]?.focus?.();
  }, [archiveDates, selectDate]);

  const snapshots = useMemo(() => ({
    ...(dayData?.snapshots || {}),
    'market-structure': marketStructureReport.data || null,
  }), [dayData, marketStructureReport.data]);
  const previousSnapshots = useMemo(() => dayData?.previousSnapshots || {}, [dayData]);
  const comparisons = useMemo(() => Object.fromEntries(PRODUCT_IDS.map((id) => [
    id,
    buildComparison(snapshots[id], previousSnapshots[id]),
  ])), [previousSnapshots, snapshots]);
  const selectedIsToday = Boolean(selectedDate && selectedDate === todayInNewYork());

  const sourceStatus = useCallback((id) => {
    if (id === 'market-structure') {
      if (archiveLoading || !selectedDate || (marketStructureReport.loading && !marketStructureReport.data)) {
        return { label: 'Loading', tone: 'neutral', current: false };
      }
      if (!marketStructureReport.data) {
        return { label: 'Not published', tone: 'neutral', current: false };
      }
      return {
        label: 'Saved',
        tone: 'fresh',
        current: true,
      };
    }
    if (archiveLoading || (dayLoading && !dayData)) return { label: 'Loading', tone: 'neutral', current: false };
    const pipelineState = publicationStatus?.date === selectedDate
      ? publicationStatus.products?.[id]?.state
      : null;
    if (!snapshots[id]) {
      if (!selectedIsToday) return { label: 'Not published', tone: 'neutral', current: false };
      if (!pipelineState) return { label: 'Checking', tone: 'neutral', current: false };
      if (['processing', 'saved', 'saved_update_failed'].includes(pipelineState)) {
        return { label: 'Preparing', tone: 'neutral', current: false };
      }
      return { label: 'Not published', tone: 'neutral', current: false };
    }
    return { label: 'Saved', tone: 'fresh', current: true };
  }, [
    archiveLoading,
    dayData,
    dayLoading,
    marketStructureReport.data,
    marketStructureReport.loading,
    publicationStatus,
    selectedDate,
    selectedIsToday,
    snapshots,
  ]);

  const scrollToSection = useCallback((id) => {
    setActiveSection(id);
    setSearchQuery('');
    setSearchResultsOpen(false);
    sectionRefs.current[id]?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, []);

  const normalizedSearch = searchQuery.trim().toLowerCase();
  const indexedMatches = useMemo(() => (
    searchIndex.query === normalizedSearch ? searchIndex.matches : []
  ), [normalizedSearch, searchIndex]);
  const searchGroups = useMemo(() => {
    const groups = new Map();
    indexedMatches.forEach((match, matchIndex) => {
      if (!groups.has(match.sectionId)) {
        const definition = TLDR_PRODUCT_DEFINITIONS.find((product) => product.id === match.sectionId);
        groups.set(match.sectionId, {
          id: match.sectionId,
          label: definition?.label || match.sectionId,
          mentions: [],
        });
      }
      groups.get(match.sectionId).mentions.push({
        matchIndex,
        snippet: match.snippet,
      });
    });
    return [...groups.values()];
  }, [indexedMatches]);

  useEffect(() => {
    const root = contentRef.current?.querySelector?.('.tldr-wiki-article');
    clearSearchHighlights(root);
    searchMatchRefs.current = [];
    setActiveSearchMatch(-1);

    if (!active || !root || !normalizedSearch) {
      setSearchIndex({ query: normalizedSearch, matches: [] });
      return undefined;
    }

    const matches = findRenderedSearchMatches(root, searchQuery);
    searchMatchRefs.current = matches;
    matches.forEach(({ element }) => element.setAttribute('data-tldr-search-match', 'true'));
    registerSearchHighlight(SEARCH_HIGHLIGHT_NAME, matches.map(({ range }) => range));
    setSearchIndex({
      query: normalizedSearch,
      matches: matches.map(({ sectionId, snippet }) => ({ sectionId, snippet })),
    });

    return () => clearSearchHighlights(root);
  }, [active, archiveLoading, normalizedSearch, searchQuery, snapshots]);

  const selectSearchMatch = useCallback((matchIndex) => {
    const matches = searchMatchRefs.current;
    if (!matches.length) return;
    const normalizedIndex = ((matchIndex % matches.length) + matches.length) % matches.length;
    const match = matches[normalizedIndex];
    const root = contentRef.current?.querySelector?.('.tldr-wiki-article');
    root?.querySelectorAll?.('[data-tldr-search-current]').forEach((node) => {
      node.removeAttribute('data-tldr-search-current');
    });
    match.element.setAttribute('data-tldr-search-current', 'true');
    registerSearchHighlight(SEARCH_CURRENT_HIGHLIGHT_NAME, [match.range]);
    setActiveSearchMatch(normalizedIndex);
    setActiveSection(match.sectionId);
    match.element.scrollIntoView?.({ behavior: 'smooth', block: 'center', inline: 'nearest' });
  }, []);

  const findRelativeSearchMatch = useCallback((direction = 1) => {
    const matchCount = searchMatchRefs.current.length;
    if (!matchCount) return;
    const nextIndex = activeSearchMatch < 0
      ? direction > 0 ? 0 : matchCount - 1
      : activeSearchMatch + direction;
    selectSearchMatch(nextIndex);
  }, [activeSearchMatch, selectSearchMatch]);

  const handleSearchKeyDown = useCallback((event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      findRelativeSearchMatch(event.shiftKey ? -1 : 1);
      setSearchResultsOpen(true);
    } else if (event.key === 'Escape') {
      setSearchResultsOpen(false);
    }
  }, [findRelativeSearchMatch]);

  const totalChanges = useMemo(() => COMPARABLE_PRODUCT_IDS.reduce((sum, id) => (
    sum + countChanges(id, snapshots[id], previousSnapshots[id], comparisons[id])
  ), 0), [comparisons, previousSnapshots, snapshots]);

  useEffect(() => {
    const root = contentRef.current;
    if (!active || !root) return undefined;

    const updateActiveSection = () => {
      const rootRect = root.getBoundingClientRect();
      const anchor = rootRect.height > 0 ? rootRect.height * 0.28 : 120;
      const sections = Object.values(sectionRefs.current)
        .filter(Boolean)
        .map((node) => ({
          id: node.dataset.sectionId,
          top: node.getBoundingClientRect().top - rootRect.top,
        }))
        .filter((section) => section.id);
      if (!sections.length) return;
      const orderedSections = [...sections].sort((left, right) => left.top - right.top);
      // The last section can remain below the reading anchor when the reader
      // reaches the true bottom of the scroll container. In that case the
      // bottom-most section is the one the reader is actually viewing, even
      // though its document top has not crossed the normal anchor yet.
      const reachedBottom = root.scrollHeight > root.clientHeight
        && root.scrollTop + root.clientHeight >= root.scrollHeight - 8;
      const current = reachedBottom
        ? orderedSections[orderedSections.length - 1]
        : orderedSections
          .filter((section) => section.top <= anchor)
          .sort((left, right) => right.top - left.top)[0]
          || orderedSections[0];
      if (current?.id) setActiveSection(current.id);
    };

    updateActiveSection();
    root.addEventListener('scroll', updateActiveSection, { passive: true });
    window.addEventListener('resize', updateActiveSection);
    return () => {
      root.removeEventListener('scroll', updateActiveSection);
      window.removeEventListener('resize', updateActiveSection);
    };
  }, [active, archiveLoading, dayData, marketStructureReport.data]);

  const currentCount = PRODUCT_IDS.filter((id) => sourceStatus(id).current).length;
  const selectedEditionLoading = dayLoading
    || Boolean(selectedDate && marketStructureReport.loading && !marketStructureReport.data);
  const saveStatus = archiveLoading
    ? <LoadingIndicator label="Loading saved editions…" size="sm" />
    : selectedEditionLoading
      ? <LoadingIndicator label={`Loading ${formatDateLong(selectedDate)}…`} size="sm" />
      : selectedDate
        ? `${formatDateLong(selectedDate)} · ${currentCount} of ${PRODUCT_IDS.length} publications saved · ${totalChanges} changes`
        : 'No saved TL;DR editions available';

  const hasEdition = Boolean(dayData);
  const canRenderSections = hasEdition
    || dayLoading
    || Boolean(selectedIsToday && (publicationStatus || statusError));

  return (
    <main className="process-wiki morning-tldr-panel morning-tldr-wiki" aria-label="Morning TL;DR" data-testid="morning-tldr-panel">
      <header className="process-wiki__site-header" data-print-hidden="true">
        <div className="process-wiki__search" role="search">
          <input
            type="search"
            value={searchQuery}
            aria-label="Search TL;DR"
            placeholder="Search TL;DR"
            onChange={(event) => {
              setSearchQuery(event.target.value);
              setSearchResultsOpen(true);
            }}
            onFocus={() => {
              if (normalizedSearch) setSearchResultsOpen(true);
            }}
            onKeyDown={handleSearchKeyDown}
          />
          <button
            type="button"
            className="process-wiki__search-label tldr-search-submit"
            aria-label={indexedMatches.length > 0
              ? `Find ${activeSearchMatch >= 0 ? 'next ' : ''}TL;DR match${activeSearchMatch >= 0 ? `, ${activeSearchMatch + 1} of ${indexedMatches.length} selected` : ''}`
              : 'Search TL;DR'}
            disabled={!normalizedSearch || indexedMatches.length === 0}
            onClick={() => {
              findRelativeSearchMatch(1);
              setSearchResultsOpen(true);
            }}
          >
            Search
          </button>
          {searchResultsOpen && normalizedSearch && (searchGroups.length > 0 || searchIndex.query === normalizedSearch) && (
            <div className="process-wiki__search-results" role="listbox" aria-label="TL;DR search results">
              {searchGroups.map((group) => (
                <div
                  className="tldr-search-group"
                  role="group"
                  aria-labelledby={`tldr-search-group-${group.id}`}
                  key={group.id}
                >
                  <div className="tldr-search-group__heading" id={`tldr-search-group-${group.id}`}>{group.label}</div>
                  <div className="tldr-search-group__mentions">
                    {group.mentions.map((mention) => (
                      <button
                        type="button"
                        role="option"
                        aria-selected={activeSearchMatch === mention.matchIndex}
                        className="process-wiki__search-result tldr-search-mention"
                        key={`${group.id}-${mention.matchIndex}`}
                        onClick={() => {
                          selectSearchMatch(mention.matchIndex);
                          setSearchResultsOpen(true);
                        }}
                      >
                        <span>{renderSearchSnippet(mention.snippet)}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              {searchGroups.length === 0 && (
                <div className="tldr-search-empty" role="status">No visible matches in this saved edition.</div>
              )}
            </div>
          )}
        </div>
        <div className="process-wiki__header-actions">
          <RefreshButton onClick={refreshTldr} loading={refreshing || archiveLoading || marketStructureReport.refreshing} iconOnly title="Refresh morning TL;DR" className="morning-tldr-refresh" />
        </div>
      </header>

      <div className="process-wiki__body">
        <aside
          className={`process-wiki__contents${searchQuery ? ' is-searching' : ''}`}
          data-print-hidden="true"
          aria-label="TL;DR contents"
        >
          <h2 className="process-wiki__side-heading">Contents</h2>
          <ol>
            {TLDR_PRODUCT_DEFINITIONS.map((definition, index) => (
              <li key={definition.id}><button type="button" className={activeSection === definition.id ? 'is-active' : ''} aria-current={activeSection === definition.id ? 'location' : undefined} onClick={() => scrollToSection(definition.id)}><small>{index + 1}</small><span>{definition.label}</span></button></li>
            ))}
          </ol>
        </aside>

        <div className="process-wiki__article-scroll" data-testid="morning-tldr-article-scroll" ref={contentRef}>
          <header className="process-wiki__document-header" data-print-hidden="true">
            <h1 id="morning-tldr-overlay-title">Morning TL;DR</h1>
            <div className="process-wiki__tabs tldr-date-tabs" role="tablist" aria-label="Saved TL;DR dates">
              {archiveDates.map((entry) => {
                const date = entry.date;
                const selected = date === selectedDate;
                return (
                  <button
                    key={date}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    tabIndex={selected ? 0 : -1}
                    aria-label={`Read ${formatDateLong(date)}`}
                    className={`process-wiki__tab tldr-date-tab${selected ? ' is-active' : ''}`}
                    data-testid={`tldr-date-tab-${date}`}
                    onClick={() => selectDate(date)}
                    onKeyDown={(event) => handleDateKeyDown(event, date)}
                  >
                    {formatDateTab(date)}
                  </button>
                );
              })}
              {!archiveLoading && archiveDates.length === 0 && <span className="process-wiki__metadata tldr-date-tabs__empty">No saved dates</span>}
            </div>
            <p className="process-wiki__save-status" aria-live="polite">
              {saveStatus}
              {selectedIsToday && statusCheckedAt && <> · Last checked {formatTimestamp(statusCheckedAt)}</>}
            </p>
          </header>

          <article className="process-wiki__article wp-paper tldr-wiki-article">
            {error && <EmptyState title="No saved TL;DR edition is available" body="No verified market publication is available for the selected date." />}
            {archiveLoading && <LoadingIndicator label="Loading saved TL;DR dates…" size="sm" centered />}
            {!archiveLoading && !canRenderSections && !error && <EmptyState title="No saved TL;DR edition is available" body="No verified market publication is available for the selected date." />}
            {!archiveLoading && canRenderSections && (
              <>
                {TLDR_PRODUCT_DEFINITIONS.map((definition) => {
                  const snapshot = snapshots[definition.id];
                  const previousSnapshot = previousSnapshots[definition.id];
                  const status = sourceStatus(definition.id);
                  const comparison = comparisons[definition.id];
                  const productPublicationState = publicationStatus?.date === selectedDate
                    ? publicationStatus.products?.[definition.id]?.state
                    : statusError?.kind === 'status' ? 'unavailable' : null;
                  return (
                    <section id={`morning-tldr-${definition.id}`} data-section-id={definition.id} data-testid={`morning-tldr-section-${definition.id}`} ref={(node) => { sectionRefs.current[definition.id] = node; }} className="tldr-wiki-section" key={definition.id}>
                      <SectionHeader title={definition.label} description={definition.description} sourceStatus={status} snapshot={snapshot} />
                      {definition.id === 'top-3-things' && (
                        <TopThreeThingsSection
                          snapshot={snapshot}
                          publicationState={productPublicationState}
                          isCurrentDate={selectedIsToday}
                        />
                      )}
                      {definition.id === 'risk-ranges' && (
                        <RiskRangesSection
                          snapshot={snapshot}
                          previousSnapshot={previousSnapshot}
                          comparison={comparison}
                          publicationState={productPublicationState}
                          isCurrentDate={selectedIsToday}
                        />
                      )}
                      {definition.id === 'early-look' && (
                        <EarlyLookSection
                          snapshot={snapshot}
                          previousSnapshot={previousSnapshot}
                          comparison={comparison}
                          publicationState={productPublicationState}
                          isCurrentDate={selectedIsToday}
                        />
                      )}
                      {(definition.id === 'the-call' || definition.id === 'the-macro-show') && (
                        <PositionSection
                          productId={definition.id}
                          snapshot={snapshot}
                          previousSnapshot={previousSnapshot}
                          publicationState={productPublicationState}
                          isCurrentDate={selectedIsToday}
                        />
                      )}
                      {definition.id === 'signal-strength' && (
                        <SignalStrengthSection
                          snapshot={snapshot}
                          publicationState={productPublicationState}
                          isCurrentDate={selectedIsToday}
                        />
                      )}
                      {definition.id === 'market-structure' && (
                        <MarketSituationReportCard
                          embedded
                          snapshot={snapshot}
                          loading={marketStructureReport.loading}
                        />
                      )}
                    </section>
                  );
                })}
              </>
            )}
          </article>
        </div>
      </div>
    </main>
  );
};

export default MorningTldrPanel;
