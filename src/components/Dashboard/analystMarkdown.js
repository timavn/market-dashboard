import { compactReviewMarkdown } from './analystReviewMarkdown';
import { presentPredictionMarkdown } from './analystPredictionMarkdown';

const normalizeMarkdownLabel = (value) => String(value || '')
  .toLowerCase()
  .replace(/[–—]/g, '-')
  .replace(/\s+/g, ' ')
  .trim();

const REDUNDANT_POSITION_SECTION_LABELS = new Set([
  'long equity and etf positions',
  'long positions',
  'short equity and etf positions',
  'short positions',
]);

const ANALYST_POSITION_TABLE_SPECS = [
  ['Contract', 'Position', 'Expiration', 'Strike / Right', 'Mark', 'Value', 'P/L'],
  ['Contract', 'Position', 'Avg Price', 'Cost Basis', 'Expiration', 'Threshold / Side', 'Mark / Settlement', 'Value', 'P/L'],
  {
    matchHeaders: ['Contract', 'Position', 'Avg Price', 'Cost Basis', 'Expiration', 'Strike / Right', 'Mark / Settlement', 'Value', 'P/L'],
    headers: ['Contract', 'Position', 'Avg Price', 'Cost Basis', 'Expiration', 'Threshold / Side', 'Mark / Settlement', 'Value', 'P/L'],
  },
  ['Contract', 'Position', 'Expiration', 'Strike / Right', 'Live Mark', 'Market Value', 'Unrealized P/L'],
  ['Contract', 'Position', 'Average Price', 'Cost Basis', 'Expiration', 'Threshold / Side', 'Live Mark', 'Market Value', 'Unrealized P/L'],
  ['Contract', 'Venue', 'Position', 'Expiration', 'Threshold / Side', 'Live Mark', 'Market Value', 'Unrealized P/L'],
  ['Market', 'Tracked Contract', 'Trend', 'Trade Levels', 'Reference', 'Range Position', 'RR Date'],
].map((spec) => (Array.isArray(spec) ? { headers: spec } : spec));

const normalizeTableCellLabel = (value) => String(value || '')
  .replace(/[*_`]/g, '')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

const splitPipeTableCells = (line) => {
  const source = String(line || '').trim();
  if (!source.startsWith('|') || !source.includes('|')) return [];
  return source.split('|').map((cell) => cell.trim()).filter(Boolean);
};

const tableSpecForHeaderCells = (cells) => ANALYST_POSITION_TABLE_SPECS.find((spec) => {
  const matchHeaders = spec.matchHeaders || spec.headers;
  return cells.length >= matchHeaders.length && matchHeaders.every((header, index) => (
    normalizeTableCellLabel(cells[index]) === normalizeTableCellLabel(header)
  ));
});

const isGfmSeparatorCell = (value) => /^:?-{3,}:?$/.test(String(value || '').trim());

const withThousandsSeparators = (value, options = {}) => {
  const plain = String(value || '').replace(/\*\*/g, '').trim();
  const normalized = plain.replace(/,/g, '').replace(/−/g, '-');
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(normalized)) return value;
  const number = Number(normalized);
  if (!Number.isFinite(number)) return value;
  const formatted = new Intl.NumberFormat('en-US', options).format(number);
  return String(value).includes('**') ? `**${formatted}**` : formatted;
};

const formatPositionTableCell = (header, value) => {
  const label = normalizeTableCellLabel(header);
  const plain = String(value || '').replace(/\*\*/g, '').trim();
  const bold = String(value || '').includes('**');
  if (label === 'expiration' && /^\d{8}$/.test(plain)) {
    const formatted = `${plain.slice(0, 4)}-${plain.slice(4, 6)}-${plain.slice(6, 8)}`;
    return bold ? `**${formatted}**` : formatted;
  }
  if (label === 'position') return withThousandsSeparators(value, { maximumFractionDigits: 8 });
  if (['avg price', 'average price', 'mark', 'live mark', 'mark / settlement'].includes(label)) {
    return withThousandsSeparators(value, { maximumFractionDigits: 4 });
  }
  if (['cost basis', 'value', 'market value', 'p/l', 'unrealized p/l'].includes(label)) {
    return withThousandsSeparators(value, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  if (['threshold / side', 'strike / right'].includes(label)) {
    const match = plain.match(/^([+-]?(?:\d+\.?\d*|\.\d+))\s*\/\s*(.+)$/);
    if (!match) return value;
    const formatted = `${withThousandsSeparators(match[1], { maximumFractionDigits: 8 })} / ${match[2]}`;
    return bold ? `**${formatted}**` : formatted;
  }
  return value;
};

const formatPipeTableRow = (cells, spec, separator = false) => {
  const formatted = separator
    ? cells
    : cells.map((cell, index) => formatPositionTableCell(spec.headers[index], cell));
  return `| ${formatted.join(' | ')} |`;
};

export const normalizeAnalystPositionTables = (markdown) => {
  const output = [];
  let activeSpec = null;
  let expectingSeparator = false;
  String(markdown || '').split('\n').forEach((line) => {
    const cells = splitPipeTableCells(line);
    const headerSpec = tableSpecForHeaderCells(cells);
    if (headerSpec) {
      const width = headerSpec.headers.length;
      const separatorCells = cells.slice(width, width * 2);
      const flattenedCells = cells.slice(width * 2);
      const isFlattened = separatorCells.length === width
        && separatorCells.every(isGfmSeparatorCell)
        && flattenedCells.length >= width
        && flattenedCells.length % width === 0;
      if (isFlattened) {
        output.push(formatPipeTableRow(headerSpec.headers, headerSpec));
        output.push(formatPipeTableRow(separatorCells, headerSpec, true));
        for (let index = 0; index < flattenedCells.length; index += width) {
          output.push(formatPipeTableRow(flattenedCells.slice(index, index + width), headerSpec));
        }
        activeSpec = null;
        expectingSeparator = false;
        return;
      }
      if (cells.length === width) {
        output.push(formatPipeTableRow(headerSpec.headers, headerSpec));
        activeSpec = headerSpec;
        expectingSeparator = true;
        return;
      }
    }
    if (activeSpec && cells.length === activeSpec.headers.length) {
      if (expectingSeparator && cells.every(isGfmSeparatorCell)) {
        output.push(formatPipeTableRow(cells, activeSpec, true));
        expectingSeparator = false;
        return;
      }
      if (!expectingSeparator) {
        output.push(formatPipeTableRow(cells, activeSpec));
        return;
      }
    }
    if (line.trim() || cells.length === 0) {
      activeSpec = null;
      expectingSeparator = false;
    }
    output.push(line);
  });
  return output.join('\n');
};

export const omitRedundantPositionSections = (markdown) => {
  let omittedHeadingLevel = null;
  const retained = [];
  String(markdown || '').split('\n').forEach((line) => {
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (omittedHeadingLevel != null) {
      if (!heading || heading[1].length > omittedHeadingLevel) return;
      omittedHeadingLevel = null;
    }
    if (heading) {
      const label = normalizeMarkdownLabel(heading[2].replace(/[*_`]/g, ''));
      if (REDUNDANT_POSITION_SECTION_LABELS.has(label)) {
        omittedHeadingLevel = heading[1].length;
        return;
      }
    }
    retained.push(line);
  });
  return retained.join('\n').replace(/\n{3,}/g, '\n\n').trim();
};

const HEDGEYE_LEVEL_PATTERN = /(\b(?:resistance|support)\b[^.\n]{0,80}?\b(?:near|around|at)\s+)(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{4,}(?:\.\d+)?)/gi;

export const emphasizeHedgeyeViewLevels = (markdown) => {
  let hedgeyeHeadingLevel = null;
  return String(markdown || '').split('\n').map((line) => {
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1].length;
      const label = normalizeMarkdownLabel(heading[2].replace(/[*_`]/g, ''));
      if (label === 'hedgeye view') hedgeyeHeadingLevel = level;
      else if (hedgeyeHeadingLevel != null && level <= hedgeyeHeadingLevel) hedgeyeHeadingLevel = null;
      return line;
    }
    if (hedgeyeHeadingLevel == null) return line;
    return line.replace(HEDGEYE_LEVEL_PATTERN, (match, lead, value, offset, source) => {
      const valueStart = offset + lead.length;
      const alreadyBold = source.slice(valueStart - 2, valueStart) === '**'
        && source.slice(valueStart + value.length, valueStart + value.length + 2) === '**';
      return alreadyBold ? match : `${lead}**${value}**`;
    });
  }).join('\n');
};

const MONTH_DATE_SOURCE = String.raw`\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2}(?:,\s+\d{4})?\b`;
const ISO_DATE_SOURCE = String.raw`\b(?:19|20)\d{2}[-/](?:0?[1-9]|1[0-2])[-/](?:0?[1-9]|[12]\d|3[01])\b`;
const NUMERIC_DATE_SOURCE = String.raw`\b(?:0?[1-9]|1[0-2])\/(?:0?[1-9]|[12]\d|3[01])(?:\/(?:19|20)\d{2})?\b`;
const TICKER_SOURCE = String.raw`(?<![A-Za-z0-9_])(?:\$[A-Z](?![A-Z])|\$?[A-Z]{2,6}(?:[./-][A-Z]{1,6})?)(?![A-Za-z0-9_])`;
const NUMBER_SOURCE = String.raw`(?<![A-Za-z0-9_])(?:[+\-−–—]\s*)?(?:[$€£]\s*)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:%|[x×])?(?![A-Za-z0-9_])`;
const ANALYST_FACT_PATTERN = new RegExp(
  `${MONTH_DATE_SOURCE}|${ISO_DATE_SOURCE}|${NUMERIC_DATE_SOURCE}|${TICKER_SOURCE}|${NUMBER_SOURCE}`,
  'g',
);

export const splitAnalystFactText = (value) => {
  const source = String(value || '');
  const parts = [];
  let cursor = 0;
  for (const match of source.matchAll(ANALYST_FACT_PATTERN)) {
    const offset = match.index ?? 0;
    if (offset > cursor) parts.push({ type: 'text', value: source.slice(cursor, offset) });
    parts.push({ type: 'strong', children: [{ type: 'text', value: match[0] }] });
    cursor = offset + match[0].length;
  }
  if (!parts.length) return [{ type: 'text', value: source }];
  if (cursor < source.length) parts.push({ type: 'text', value: source.slice(cursor) });
  return parts;
};

export const cleanAnalystText = (value) => String(value || '')
  .replace(/\uE200\s*(?:cite_[a-f0-9]{32}|\[invalid citation removed\])\s*\uE201/gi, '')
  .replace(/\[invalid citation removed\]/gi, '')
  .replace(/[\uE200\uE201]/g, '');

export const prepareAnalystMarkdown = (value, options) => {
  const markdown = presentPredictionMarkdown(compactReviewMarkdown(
    normalizeAnalystPositionTables(emphasizeHedgeyeViewLevels(omitRedundantPositionSections(cleanAnalystText(value)))),
  ), options);
  return options?.reviewKind === 'portfolio-review' ? markdown
    .replace(/^\s{0,3}#{1,2}\s+Portfolio Review(?:\s+[—–-]\s+(?:Ready|Partial|Blocked))?\s*$/gmi, '')
    .replaceAll('<!-- analyst-daily-rollup -->', '').trim() : markdown;
};
